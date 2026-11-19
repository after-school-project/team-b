import { verifyPassword } from "better-auth/crypto";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  return runAccountTask("account:issue", "--input", inputFile, "--output", output);
}

function runAccountTask(task: string, ...args: string[]) {
  return spawnSync("npm", ["run", task, "--", ...args], {
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
    current_revision_id: string;
  }>(`
    SELECT u.id, u.email_verified, a.password, c.base_role,
      c.app_manager, c.school_manager, c.eligibility_status, c.provisioning_status,
      i.private_real_name, i.school_reference, r.display_name, p.current_revision_id
    FROM "user" u
    JOIN account a ON a.user_id = u.id AND a.provider_id = 'credential'
    JOIN community_users c ON c.user_id = u.id
    JOIN identity_records i ON i.user_id = u.id
    JOIN profiles p ON p.user_id = u.id
    JOIN profile_revisions r ON r.id = p.current_revision_id
    WHERE u.username = $1
  `, [username])).rows[0];
}

async function accountAudits(userId?: string) {
  return (await database.client.query(`
    SELECT action_type, target_type, actor_id, system_action, before_state, after_state
    FROM audit_logs WHERE ($1::text IS NULL OR target_id = $1)
    ORDER BY action_type
  `, [userId ?? null])).rows;
}

const issuedAudit = {
  action_type: "account.issued", target_type: "user", actor_id: null, system_action: true,
  before_state: null, after_state: null,
};

it("学校確認済みアカウントを発行し、重複時は認証情報・所属・権限を保持する", async () => {
  const output = join(directory, "credentials.json");
  const displayName = "𠮷".repeat(50);
  const issued = await issueAccount({ ...fixture, displayName: `  ${displayName}  ` }, output);
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
    display_name: displayName,
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
  expect(await accountAudits(before.id)).toEqual([issuedAudit]);
});

it("出力先が既にある場合は上書きせず、認証アカウントの発行も取り消す", async () => {
  const username = "issue33_rollback";
  const output = join(directory, "existing.json");
  await writeFile(output, "既存ファイル");
  const before = await accountAudits();
  const result = await issueAccount({ ...fixture, username }, output);
  expect(result.status).toBe(1);
  expect(await readFile(output, "utf8")).toBe("既存ファイル");
  const users = await database.client.query('SELECT id FROM "user" WHERE username = $1', [username]);
  expect(users.rowCount).toBe(0);
  expect(await accountAudits()).toEqual(before);
});

it.each([
  { username: "INVALID-ID" },
  { baseRole: "student" },
  { schoolVerified: false },
  { schoolReference: "  " },
  { displayName: "  " },
  { displayName: "名".repeat(51) },
  { displayName: "姓\n名" },
  { displayName: "姓\u2028名" },
])("不正な発行情報をDB更新前に拒否する: %o", async (override) => {
  const output = join(directory, "invalid.json");
  const username = "issue33_invalid";
  const result = await issueAccount({ ...fixture, username, ...override }, output);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("発行情報の形式");
  await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await account(override.username ?? username)).toBeUndefined();
});

it("再発行は対象の旧パスワードと全セッションだけを無効にする", async () => {
  const username = "issue33_reset";
  const originalFile = join(directory, "before-reset.json");
  expect((await issueAccount({ ...fixture, username }, originalFile)).status).toBe(0);
  const { password: oldPassword } = JSON.parse(await readFile(originalFile, "utf8")) as { password: string };
  const { password: oldHash, ...before } = await account(username);

  const otherUserId = randomUUID();
  await database.client.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [otherUserId, "別の利用者", "other_reset@example.invalid"]);
  const targetSessions = [randomUUID(), randomUUID()];
  const otherSession = randomUUID();
  for (const [id, userId] of [
    ...targetSessions.map((id) => [id, before.id]),
    [otherSession, otherUserId],
  ]) {
    await database.client.query(`
      INSERT INTO "session" (id, user_id, token, expires_at, updated_at)
      VALUES ($1, $2, $3, now() + interval '1 hour', now())
    `, [id, userId, randomUUID()]);
  }
  const sessionIds = async () => (await database.client.query<{ id: string }>(
    'SELECT id FROM "session" WHERE user_id IN ($1, $2) ORDER BY id', [before.id, otherUserId],
  )).rows.map(({ id }) => id);

  const categoryId = randomUUID();
  await database.client.query("INSERT INTO qa_categories (id, code, name) VALUES ($1, 'reset_test', 'テスト')",
    [categoryId]);
  await database.client.query(`
    INSERT INTO qa_questions (author_id, category_id, title, body_markdown, author_label)
    VALUES ($1, $2, '架空の質問', '本文', '架空の職員')
  `, [before.id, categoryId]);
  const posts = async () => (await database.client.query(
    "SELECT * FROM qa_questions WHERE author_id = $1", [before.id],
  )).rows;
  const beforePosts = await posts();
  expect(beforePosts).toHaveLength(1);

  const failed = runAccountTask("account:reset-password", "--username", username, "--output", originalFile);
  expect(failed.status).toBe(1);
  expect((await account(username)).password === oldHash).toBe(true);
  expect(await sessionIds()).toEqual([...targetSessions, otherSession].sort());
  expect(await accountAudits(before.id)).toEqual([issuedAudit]);

  const output = join(directory, "reset.json");
  const reset = runAccountTask("account:reset-password", "--username", username, "--output", output);
  expect(reset.status).toBe(0);
  const issued = JSON.parse(await readFile(output, "utf8")) as { username: string; password: string };
  expect(issued.username).toBe(username);
  expect(typeof issued.password === "string" && /^[A-Za-z0-9_-]{24}$/.test(issued.password)).toBe(true);
  const logs = reset.stdout + reset.stderr + failed.stdout + failed.stderr;
  expect(logs.includes(oldPassword) || logs.includes(issued.password)).toBe(false);

  const { password: newHash, ...after } = await account(username);
  expect(newHash !== issued.password && await verifyPassword({ hash: newHash, password: issued.password })).toBe(true);
  expect(await verifyPassword({ hash: newHash, password: oldPassword })).toBe(false);
  expect(await sessionIds()).toEqual([otherSession]);
  expect(after).toEqual(before);
  expect(await posts()).toEqual(beforePosts);
  expect(await accountAudits(before.id)).toEqual([
    issuedAudit,
    { ...issuedAudit, action_type: "account.password_reset" },
  ]);
});

it("未発行のログインIDに対して受渡用ファイルを作らない", async () => {
  const output = join(directory, "missing-reset.json");
  const result = runAccountTask("account:reset-password", "--username", "issue33_missing", "--output", output);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("再発行できる学校発行アカウントが見つかりません");
  await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
});
