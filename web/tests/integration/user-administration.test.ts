import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import * as auditDetail from "../../src/app/api/v1/admin/audit-logs/[logId]/route";
import * as auditList from "../../src/app/api/v1/admin/audit-logs/route";
import { GET as dashboard } from "../../src/app/api/v1/admin/dashboard/route";
import { GET as deletedEvidence } from "../../src/app/api/v1/admin/report-cases/[caseId]/evidence/[evidenceId]/route";
import { POST as role } from "../../src/app/api/v1/admin/users/[userId]/app-manager-role/route";
import { GET as identity } from "../../src/app/api/v1/admin/users/[userId]/identity/route";
import { GET as detail } from "../../src/app/api/v1/admin/users/[userId]/route";
import { POST as suspension } from "../../src/app/api/v1/admin/users/[userId]/suspension/route";
import { GET as users } from "../../src/app/api/v1/admin/users/route";
import { GET as me } from "../../src/app/api/v1/me/route";
import { endPool, isolatedDatabase } from "./isolated-database";

const origin = "https://school.example";
const school = "poc_school";
const manager = "poc_s_mgr";
const otherManager = "poc_a_mgr";
const student = "poc_s001";
const roleTarget = "poc_s002";
const alumni = "poc_a001";
const hidden = "poc_hidden";
const publicReason = "本人向けテスト理由";
const internalReason = "内部向けテスト理由";
const privateMarker = "非公開本人情報テスト";
const postMarker = "削除証拠のテスト本文";
const adminPath = "/api/v1/admin";
const usersPath = `${adminPath}/users`;
const auditPath = `${adminPath}/audit-logs`;

let database: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let seedDir: string;
const ids = new Map<string, string>();
const cookies = new Map<string, string>();

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: drizzle(pool) }));

beforeAll(async () => {
  database = await isolatedDatabase();
  await migrateDatabase(database.client);
  pool = new Pool({ connectionString: database.url.toString() });
  seedDir = await mkdtemp(join(tmpdir(), "team-b-user-administration-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(database.client), seedDir);
  const credentials: Record<string, string> = JSON.parse(await readFile(join(seedDir, "accounts.json"), "utf8"));
  const { POST: signIn } = await import("../../src/app/api/auth/[...auth]/route");
  for (const [index, username] of [school, manager, otherManager, student, roleTarget, alumni, hidden].entries()) {
    const { rows: [account] } = await database.client.query<{ id: string }>('SELECT id FROM "user" WHERE username = $1', [username]);
    ids.set(username, account.id);
    const response = await signIn(new Request(`${origin}/api/auth/sign-in/username`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${index + 1}` },
      body: JSON.stringify({ username, password: credentials[username] }),
    }));
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie()
      .find((value) => value.startsWith("__Secure-better-auth.session_token="))?.split(";", 1)[0];
    if (!cookie) throw new Error("ユーザー管理テストのセッションを発行できませんでした。");
    cookies.set(username, cookie);
  }
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await endPool(pool);
  if (seedDir) await rm(seedDir, { recursive: true, force: true });
  await database?.dispose();
});

function id(username: string) { return ids.get(username)!; }
function params<T>(values: T) { return { params: Promise.resolve(values) }; }

function request(actor: string, path: string, body?: object, key = randomUUID()) {
  const headers = new Headers({ Cookie: cookies.get(actor)! });
  if (body === undefined) return new Request(origin + path, { headers });
  headers.set("Origin", origin);
  headers.set("Content-Type", "application/json");
  headers.set("Idempotency-Key", key);
  return new Request(origin + path, { method: "POST", headers, body: JSON.stringify(body) });
}

async function snapshot(response: Response) {
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}

async function version(username: string) {
  const { rows: [row] } = await database.client.query<{ version: number }>(
    "SELECT version FROM community_users WHERE user_id = $1", [id(username)]);
  return row.version;
}

async function accountCase(subject: string, assignee: string | null, schoolOnly = false, kind: "account" | "profile" = "account") {
  const { rows: [row] } = await database.client.query<{ id: string }>(`
    WITH target AS (INSERT INTO report_targets (kind, subject_user_id) VALUES ($1, $2) RETURNING id)
    INSERT INTO report_cases (target_id, assignee_id, handoff_pending, school_only)
    SELECT id, $3, $3::text IS NULL, $4 FROM target RETURNING id
  `, [kind, id(subject), assignee ? id(assignee) : null, schoolOnly]);
  return row.id;
}

async function changeSuspension(actor: string, target: string, body: object, key?: ReturnType<typeof randomUUID>) {
  return snapshot(await suspension(request(actor, `${usersPath}/${id(target)}/suspension`, body, key), params({ userId: id(target) })));
}

async function changeRole(actor: string, target: string, body: object, key?: ReturnType<typeof randomUUID>) {
  return snapshot(await role(request(actor, `${usersPath}/${id(target)}/app-manager-role`, body, key), params({ userId: id(target) })));
}

it("AC-01 管理ホームは自己申請・対応不能なイベント・権限外の通報を除外する", async () => {
  const { rows: [notice] } = await database.client.query<{ id: string }>("SELECT notice_id AS id FROM notice_requests WHERE status = 'pending'");
  await database.client.query("UPDATE notices SET author_id = $1 WHERE id = $2", [id(otherManager), notice.id]);
  const { rows: [event] } = await database.client.query<{ id: string; revision: string }>(
    "SELECT event_id AS id, revision_id AS revision FROM event_requests WHERE status = 'pending'");
  await database.client.query("UPDATE events SET author_id = $1 WHERE id = $2", [id(otherManager), event.id]);
  await database.client.query("UPDATE event_revisions SET starts_at = now() + interval '2 days' WHERE id = $1", [event.revision]);
  await accountCase(student, school);
  await accountCase(alumni, school, true);
  await accountCase(hidden, null);

  for (const [actor, expected] of [[school, [1, 1, 3]], [otherManager, [0, 0, 1]]] as const) {
    const response = await snapshot(await dashboard(request(actor, `${adminPath}/dashboard`), undefined));
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      counts: { noticeRequests: expected[0], eventRequests: expected[1], unhandledReports: expected[2] },
      navigation: { canViewAuditLogs: actor === school, canViewHandoffs: actor === school, canViewUsers: true },
    });
  }
  await database.client.query("UPDATE event_revisions SET starts_at = now() - interval '2 days' WHERE id = $1", [event.revision]);
  const eventCount = async () =>
    (await snapshot(await dashboard(request(school, `${adminPath}/dashboard`), undefined))).body.data.counts.eventRequests;
  expect(await eventCount()).toBe(0);
  const { rows: [published] } = await database.client.query<{ id: string }>(`
    INSERT INTO event_revisions (event_id, revision_no, title, description, starts_at, format)
    VALUES ($1, 2, '公開版のイベント', '集計の検証用', now() - interval '2 days', 'online') RETURNING id
  `, [event.id]);
  await database.client.query("UPDATE events SET public_revision_id = $1, first_published_at = now() WHERE id = $2", [published.id, event.id]);
  await database.client.query("UPDATE event_requests SET request_kind = 'edit' WHERE event_id = $1", [event.id]);
  await database.client.query("UPDATE event_revisions SET starts_at = now() + interval '2 days' WHERE id = $1", [event.revision]);
  expect(await eventCount()).toBe(0);
  await database.client.query("UPDATE event_revisions SET ends_at = now() + interval '1 day' WHERE id = $1", [published.id]);
  expect(await eventCount()).toBe(1);
  expect((await dashboard(request(student, `${adminPath}/dashboard`), undefined)).status).toBe(403);
});

it("AC-02 管理対象の検索・件数・詳細は非公開情報を使わず、本人確認は学校管理者に限る", async () => {
  await database.client.query("UPDATE identity_records SET private_real_name = $1 WHERE user_id = $2", [privateMarker, id(student)]);
  await database.client.query("UPDATE profile_revisions SET display_name = $1 WHERE user_id = $2", [privateMarker, id(hidden)]);
  const lookup = `${usersPath}/${id(student)}`;
  for (const actor of [manager, school]) {
    const query = await snapshot(await users(request(actor, `${usersPath}?q=${encodeURIComponent(privateMarker)}`), undefined));
    expect(query.body).toMatchObject({ data: { items: [] }, meta: { page: { totalCount: 0 } } });
    const result = await snapshot(await detail(request(actor, lookup), params({ userId: id(student) })));
    expect(result.status).toBe(200);
    expect(result.body.data.capabilities.canViewIdentity).toBe(actor === school);
    expect(result.text).not.toContain(privateMarker);
  }
  const query = await snapshot(await users(request(manager,
    `${usersPath}?q=${id(student)}&baseRole=student&accountStatus=active&managerRole=none`), undefined));
  expect(query.body.data.items).toEqual([expect.objectContaining({ userId: id(student) })]);
  const first = await snapshot(await users(request(manager, `${usersPath}?limit=1`), undefined));
  const next = await snapshot(await users(request(manager,
    `${usersPath}?limit=50&cursor=${first.body.meta.page.nextCursor}`), undefined));
  expect(next.body.data.items).toHaveLength(first.body.meta.page.totalCount - 1);
  expect(next.body.data.items).not.toContainEqual(expect.objectContaining({ userId: first.body.data.items[0].userId }));

  const forbidden = await snapshot(await identity(request(manager, `${lookup}/identity`), params({ userId: id(student) })));
  expect(forbidden.status).toBe(403);
  expect(forbidden.text).not.toContain(privateMarker);
  const allowed = await snapshot(await identity(request(school, `${lookup}/identity`), params({ userId: id(student) })));
  expect(allowed.body.data.privateRealName).toBe(privateMarker);
  expect(Object.keys(allowed.body.data).sort()).toEqual(
    ["userId", "privateRealName", "schoolReference", "email", "emailVerified", "verificationNote"].sort());
});

it("AC-03 / SEC-22 学校管理者は理由付きでアプリ管理者を停止・解除し、既存セッションと担当案件に反映する", async () => {
  const assigned = await accountCase(student, manager, false, "profile");
  const source = await accountCase(manager, school, true);
  const payload = { expectedVersion: await version(manager), suspended: true, publicReason, internalReason, sourceCaseId: source };
  for (const missing of [{ publicReason: undefined }, { internalReason: "　" }]) {
    const invalid = await changeSuspension(school, manager, { ...payload, ...missing });
    expect(invalid.status).toBe(422);
    expect(invalid.text).not.toContain(internalReason);
  }
  for (const [actor, target] of [[otherManager, manager], [school, school]]) {
    const denied = await changeSuspension(actor, target, payload);
    expect(denied.status).toBe(403);
    expect(denied.text).not.toContain(internalReason);
  }
  const wrongCase = await changeSuspension(school, manager, { ...payload, sourceCaseId: assigned });
  expect(wrongCase.status).toBe(422);
  await database.client.query(`
    ALTER TABLE audit_logs ADD CONSTRAINT reject_test_suspension CHECK (action_type <> 'account.suspended') NOT VALID
  `);
  try {
    const failed = await changeSuspension(school, manager, payload);
    expect(failed.status).toBe(500);
    expect(failed.text).not.toContain(internalReason);
    expect(await version(manager)).toBe(payload.expectedVersion);
    const { rows: [unchanged] } = await database.client.query(
      "SELECT assignee_id, handoff_pending FROM report_cases WHERE id = $1", [assigned]);
    expect(unchanged).toEqual({ assignee_id: id(manager), handoff_pending: false });
  } finally {
    await database.client.query("ALTER TABLE audit_logs DROP CONSTRAINT reject_test_suspension");
  }
  const key = randomUUID();
  const [saved, replay] = await Promise.all([changeSuspension(school, manager, payload, key), changeSuspension(school, manager, payload, key)]);
  expect([saved.status, replay.status]).toEqual([200, 200]);
  expect(new Set([saved.body.meta.replayed ?? false, replay.body.meta.replayed ?? false])).toEqual(new Set([false, true]));
  expect(saved.body.data.state).toBe("suspended");
  const account = await snapshot(await me(request(manager, "/api/v1/me"), undefined));
  expect(account.body.data).toEqual({ access: "suspended", publicReason });
  expect(account.text).not.toContain(internalReason);
  const rejected = await snapshot(await dashboard(request(manager, `${adminPath}/dashboard`), undefined));
  expect(rejected.body.error.code).toBe("ACCOUNT_SUSPENDED");
  expect(rejected.text).not.toContain(internalReason);
  const hiddenReason = await snapshot(await detail(request(otherManager, `${usersPath}/${id(manager)}`), params({ userId: id(manager) })));
  expect(hiddenReason.body.data.suspensionReason).toBeNull();
  const { rows: [handoff] } = await database.client.query(
    "SELECT status, handoff_pending, assignee_id FROM report_cases WHERE id = $1", [assigned]);
  expect(handoff).toEqual({ status: "unhandled", handoff_pending: true, assignee_id: null });
  const resume = { ...payload, expectedVersion: payload.expectedVersion + 1, suspended: false };
  expect((await changeSuspension(school, manager, { ...resume, internalReason: "" })).status).toBe(422);
  expect((await changeSuspension(school, manager, { ...resume, suspended: true })).body.error.code).toBe("STATE_CONFLICT");
  expect((await changeSuspension(school, manager, resume)).body.data.state).toBe("active");
  expect((await dashboard(request(manager, `${adminPath}/dashboard`), undefined)).status).toBe(200);
  const { rows: restrictions } = await database.client.query(
    "SELECT action, public_reason, internal_reason FROM account_restrictions WHERE user_id = $1 ORDER BY created_at", [id(manager)]);
  expect(restrictions).toEqual(["suspend", "release"].map((action) => ({ action, public_reason: publicReason, internal_reason: internalReason })));
  const { rows: measures } = await database.client.query(
    "SELECT action_type FROM report_actions WHERE case_id = $1 ORDER BY created_at", [source]);
  expect(measures.map(({ action_type }) => action_type)).toEqual(["account_suspended", "account_resumed"]);
  const { rows: audit } = await database.client.query(
    "SELECT action_type, public_reason FROM audit_logs WHERE target_id = $1 AND action_type LIKE 'account.%' ORDER BY created_at", [id(manager)]);
  expect(audit).toEqual(["account.suspended", "account.resumed"].map((action_type) => ({ action_type, public_reason: publicReason })));

  const general = { ...payload, sourceCaseId: undefined, expectedVersion: await version(student) };
  expect((await changeSuspension(manager, student, general)).status).toBe(200);
  expect((await changeSuspension(school, student, { ...general, expectedVersion: general.expectedVersion + 1, suspended: false })).status).toBe(200);
});

it("AC-04 付与で学校専用化し、解除ではセッション・基本所属を維持して担当を引き継ぐ", async () => {
  const subjectCase = await accountCase(roleTarget, manager);
  const expectedVersion = await version(roleTarget);
  const granted = { expectedVersion, assigned: true };
  expect((await changeRole(manager, roleTarget, granted)).status).toBe(403);
  expect((await changeRole(school, school, granted)).status).toBe(403);
  expect((await changeRole(school, roleTarget, granted)).body.data.state).toBe("assigned");
  expect((await dashboard(request(roleTarget, `${adminPath}/dashboard`), undefined)).status).toBe(200);
  const { rows: [restricted] } = await database.client.query(
    "SELECT school_only, assignee_id, handoff_pending FROM report_cases WHERE id = $1", [subjectCase]);
  expect(restricted).toEqual({ school_only: true, assignee_id: null, handoff_pending: true });
  const assigned = await accountCase(alumni, roleTarget, false, "profile");
  const revoked = { expectedVersion: expectedVersion + 1, assigned: false };
  expect((await changeRole(school, roleTarget, { ...revoked, expectedVersion })).body.error.code).toBe("VERSION_CONFLICT");
  expect((await changeRole(school, roleTarget, revoked)).body.data.state).toBe("revoked");
  expect((await dashboard(request(roleTarget, `${adminPath}/dashboard`), undefined)).status).toBe(403);
  expect((await snapshot(await me(request(roleTarget, "/api/v1/me"), undefined))).body.data)
    .toMatchObject({ access: "active", baseRole: "student", isGraduating: true });
  const { rows: [handoff] } = await database.client.query(
    "SELECT assignee_id, handoff_pending FROM report_cases WHERE id = $1", [assigned]);
  expect(handoff).toEqual({ assignee_id: null, handoff_pending: true });
  const { rows: history } = await database.client.query(
    "SELECT before_app_manager, after_app_manager FROM manager_role_changes WHERE user_id = $1 ORDER BY created_at", [id(roleTarget)]);
  expect(history).toEqual([{ before_app_manager: false, after_app_manager: true }, { before_app_manager: true, after_app_manager: false }]);
  const { rows: audit } = await database.client.query(
    "SELECT action_type FROM audit_logs WHERE target_id = $1 AND action_type LIKE 'app_manager.%' ORDER BY created_at", [id(roleTarget)]);
  expect(audit.map(({ action_type }) => action_type)).toEqual(["app_manager.assigned", "app_manager.revoked"]);
});

it("AC-05 / SEC-21 学校管理者だけが期限内の監査ログと削除済み証拠を取得できる", async () => {
  const { rows: [logs] } = await database.client.query<{ old: string; recent: string }>(`
    WITH expired AS (
      INSERT INTO audit_logs (system_action, action_type, target_type, target_id, created_at)
      VALUES (true, 'account.issued', 'user', $1, now() - interval '1 year') RETURNING id
    ), retained AS (
      INSERT INTO audit_logs (system_action, action_type, target_type, target_id, after_state, created_at)
      VALUES (true, 'account.suspended', 'user', $1, $2::jsonb, now() - interval '1 year' + interval '1 hour') RETURNING id
    ) SELECT expired.id AS old, retained.id AS recent FROM expired, retained
  `, [id(student), JSON.stringify({ accountStatus: "suspended", bodyMarkdown: postMarker, privateRealName: privateMarker, token: privateMarker })]);

  const first = await snapshot(await auditList.GET(request(school, `${auditPath}?limit=1`), undefined));
  const following = await snapshot(await auditList.GET(request(school,
    `${auditPath}?limit=50&cursor=${first.body.meta.page.nextCursor}`), undefined));
  const all = [...first.body.data.items, ...following.body.data.items];
  expect(all).toHaveLength(first.body.meta.page.totalCount);
  expect(all.map(({ id }) => id)).toContain(logs.recent);
  expect(all.map(({ id }) => id)).not.toContain(logs.old);
  const readLog = async (actor: string, logId: string) =>
    snapshot(await auditDetail.GET(request(actor, `${auditPath}/${logId}`), params({ logId })));
  expect((await readLog(school, logs.recent)).body.data.afterState).toEqual({ accountStatus: "suspended" });
  expect((await readLog(school, logs.old)).status).toBe(404);
  expect((await auditDetail.DELETE(request(school, `${auditPath}/${logs.recent}`), params({ logId: logs.recent }))).status).toBe(405);
  for (const result of [await readLog(manager, logs.recent), await snapshot(await auditList.GET(request(manager, auditPath), undefined))]) {
    expect(result.status).toBe(403);
    expect(result.text).not.toContain(privateMarker);
    expect(result.text).not.toContain(publicReason);
  }
  expect(JSON.stringify(all)).not.toContain(privateMarker);
  expect(JSON.stringify(all)).not.toContain(postMarker);
  expect(JSON.stringify(all)).not.toContain(internalReason);

  const { rows: [evidence] } = await database.client.query<{ case_id: string; evidence_id: string }>(
    "SELECT case_id, evidence_id FROM report_case_evidence LIMIT 1");
  await database.client.query(`
    UPDATE qa_questions SET deleted_at = now()
    WHERE id = (SELECT question_id FROM report_targets JOIN report_cases ON report_cases.target_id = report_targets.id WHERE report_cases.id = $1)
  `, [evidence.case_id]);
  const addr = `${adminPath}/report-cases/${evidence.case_id}/evidence/${evidence.evidence_id}`;
  const context = params({ caseId: evidence.case_id, evidenceId: evidence.evidence_id });
  const denied = await snapshot(await deletedEvidence(request(manager, addr), context));
  expect(denied.status).toBe(404);
  expect(denied.text).not.toContain("bodyMarkdown");
  expect((await deletedEvidence(request(school, addr), context)).status).toBe(200);
});
