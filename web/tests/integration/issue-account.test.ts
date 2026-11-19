import { verifyPassword } from "better-auth/crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { isolatedDatabase } from "./isolated-database";

const fixture = {
  username: "issue33_staff",
  displayName: "架空の職員",
  baseRole: "staff",
  schoolManager: true,
  appManager: false,
  schoolVerified: true,
  privateRealName: "架空の本人確認名",
  schoolReference: "DEMO-33",
};

let database: Awaited<ReturnType<typeof isolatedDatabase>>;
let directory: string;

beforeAll(async () => {
  database = await isolatedDatabase();
  directory = await mkdtemp(join(tmpdir(), "team-b-issue-"));
  await migrateDatabase(database.client);
});

afterAll(async () => {
  try {
    if (database) await database.dispose();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function issueAccount(input: typeof fixture, output: string) {
  const inputFile = join(directory, "input.json");
  await writeFile(inputFile, JSON.stringify(input), { mode: 0o600 });
  return spawnSync("npm", ["run", "account:issue", "--", "--input", inputFile, "--output", output], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      DATABASE_URL_DIRECT: database.url.toString(),
      BETTER_AUTH_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: "integration-tests-only-issue-account-fixture",
    },
  });
}

async function account(username: string) {
  return (await database.client.query<{
    id: string;
    password: string;
    email_verified: boolean;
    base_role: string;
    app_manager: boolean;
    school_manager: boolean;
    eligibility_status: string;
    provisioning_status: string;
    private_real_name: string;
    school_reference: string;
    display_name: string;
  }>(`
    SELECT u.id, u.email_verified, a.password, c.base_role,
      c.app_manager, c.school_manager, c.eligibility_status, c.provisioning_status,
      i.private_real_name, i.school_reference, r.display_name
    FROM "user" u
    JOIN account a ON a.user_id = u.id AND a.provider_id = 'credential'
    JOIN community_users c ON c.user_id = u.id
    JOIN identity_records i ON i.user_id = u.id
    JOIN profiles p ON p.user_id = u.id
    JOIN profile_revisions r ON r.id = p.current_revision_id
    WHERE u.username = $1
  `, [username])).rows[0];
}

it("学校確認済みアカウントを発行し、重複時は認証情報・所属・権限を保持する", async () => {
  const output = join(directory, "credentials.json");
  const issued = await issueAccount(fixture, output);
  expect(issued.status).toBe(0);
  const { username, password } = JSON.parse(await readFile(output, "utf8")) as {
    username: string; password: string;
  };
  expect(username).toBe(fixture.username);
  expect(typeof password === "string" && /^[A-Za-z0-9_-]{24}$/.test(password)).toBe(true);
  expect((issued.stdout + issued.stderr).includes(password)).toBe(false);

  const { password: hash, ...before } = await account(fixture.username);
  expect(before).toMatchObject({
    email_verified: false,
    base_role: "staff",
    school_manager: true,
    app_manager: false,
    eligibility_status: "verified",
    provisioning_status: "ready",
    private_real_name: fixture.privateRealName,
    school_reference: fixture.schoolReference,
    display_name: fixture.displayName,
  });
  expect(hash !== password && await verifyPassword({ hash, password })).toBe(true);

  const duplicateOutput = join(directory, "duplicate.json");
  const repeated = await issueAccount({
    ...fixture, baseRole: "alumni", schoolManager: false, appManager: true,
  }, duplicateOutput);
  expect(repeated.status).toBe(1);
  expect(repeated.stderr).toContain("このログインIDは発行済み");
  await expect(readFile(duplicateOutput)).rejects.toMatchObject({ code: "ENOENT" });
  const { password: currentHash, ...after } = await account(fixture.username);
  expect(currentHash === hash).toBe(true);
  expect(after).toEqual(before);
});

it("出力先が既にある場合は上書きせず、認証アカウントの発行も取り消す", async () => {
  const username = "issue33_rollback";
  const output = join(directory, "existing.json");
  await writeFile(output, "既存ファイル");
  const result = await issueAccount({ ...fixture, username }, output);
  expect(result.status).toBe(1);
  expect(await readFile(output, "utf8")).toBe("既存ファイル");
  const users = await database.client.query('SELECT id FROM "user" WHERE username = $1', [username]);
  expect(users.rowCount).toBe(0);
});

it.each([
  { username: "INVALID-ID" },
  { baseRole: "student" },
  { schoolVerified: false },
  { schoolReference: "  " },
])("不正な発行情報をDB更新前に拒否する: %o", async (override) => {
  const output = join(directory, "invalid.json");
  const result = await issueAccount({ ...fixture, ...override }, output);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("発行情報の形式");
  await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
});
