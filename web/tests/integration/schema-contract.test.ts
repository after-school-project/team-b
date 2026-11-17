import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { isolatedDatabase } from "./isolated-database";

let target: Awaited<ReturnType<typeof isolatedDatabase>>;
const user = randomUUID();
const other = randomUUID();
const category = randomUUID();
const question = randomUUID();
const secondQuestion = randomUUID();
const answer = randomUUID();
const revision = randomUUID();
const notice = randomUUID();
const noticeRevision = randomUUID();
const event = randomUUID();
const eventRevision = randomUUID();
const otherNoticeRevision = randomUUID();
const otherEventRevision = randomUUID();

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  await migrateDatabase(target.client); // 再適用でもテーブル・履歴を増やさない。
  await target.client.query('INSERT INTO "user" (id, name, email) VALUES ($1, $1, $2), ($3, $3, $4)',
    [user, `${user}@example.invalid`, other, `${other}@example.invalid`]);
  await target.client.query("INSERT INTO community_users (user_id, base_role) VALUES ($1, 'student'), ($2, 'staff')", [user, other]);
  await target.client.query("INSERT INTO profile_revisions (id, user_id, revision_no, display_name) VALUES ($1, $2, 1, '架空')", [revision, user]);
  await target.client.query("INSERT INTO qa_categories (id, code, name) VALUES ($1, 'test', 'テスト')", [category]);
  await target.client.query(`INSERT INTO qa_questions (id, author_id, category_id, title, body_markdown, author_label)
    VALUES ($1, $3, $4, '質問', '本文', '架空'), ($2, $3, $4, '別質問', '本文', '架空')`, [question, secondQuestion, user, category]);
  await target.client.query(`INSERT INTO qa_responses (id, question_id, author_id, kind, body_markdown, author_label)
    VALUES ($1, $2, $3, 'answer', '回答', '架空')`, [answer, question, other]);
  await target.client.query("INSERT INTO notices (id, author_id, origin_kind) VALUES ($1, $2, 'school')", [notice, other]);
  await target.client.query("INSERT INTO notice_revisions (id, notice_id, revision_no, title, body, category_code) VALUES ($1, $2, 1, '題', '本文', 'test')", [noticeRevision, notice]);
  await target.client.query("INSERT INTO events (id, author_id, origin_kind) VALUES ($1, $2, 'staff')", [event, other]);
  await target.client.query(`INSERT INTO event_revisions (id, event_id, revision_no, title, description, starts_at, format)
    VALUES ($1, $2, 1, '催し', '本文', now(), 'online')`, [eventRevision, event]);
  const anotherNotice = randomUUID();
  const anotherEvent = randomUUID();
  await target.client.query("INSERT INTO notices (id, author_id, origin_kind) VALUES ($1, $2, 'school')", [anotherNotice, other]);
  await target.client.query("INSERT INTO notice_revisions (id, notice_id, revision_no, title, body, category_code) VALUES ($1, $2, 1, '題', '本文', 'test')", [otherNoticeRevision, anotherNotice]);
  await target.client.query("INSERT INTO events (id, author_id, origin_kind) VALUES ($1, $2, 'staff')", [anotherEvent, other]);
  await target.client.query("INSERT INTO event_revisions (id, event_id, revision_no, title, description, starts_at, format) VALUES ($1, $2, 1, '催し', '本文', now(), 'online')", [otherEventRevision, anotherEvent]);
});

afterAll(async () => { await target?.dispose(); });

async function probe(query: string, values: unknown[] = []) {
  await target.client.query("BEGIN");
  try { await target.client.query(query, values); }
  finally { await target.client.query("ROLLBACK"); }
}

describe("DB・ER設計書の保存契約", () => {
  it("空DBに全マイグレーションを適用し、31テーブルすべてに主キーがある", async () => {
    const tables = await target.client.query<{ name: string; primary_key: boolean }>(`SELECT c.relname AS name,
      EXISTS (SELECT FROM pg_constraint p WHERE p.conrelid=c.oid AND p.contype='p') AS primary_key
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`);
    expect(tables.rows.map((row) => row.name)).toEqual([
      "account", "account_restrictions", "audit_logs", "community_users", "event_requests", "event_revisions", "events",
      "evidence_snapshots", "graduation_changes", "identity_records", "manager_role_changes", "notice_requests",
      "notice_revisions", "notices", "notifications", "operation_receipts", "profile_reviews", "profile_revisions", "profiles",
      "qa_categories", "qa_questions", "qa_responses", "rate_limit", "report_actions", "report_case_evidence", "report_cases",
      "report_targets", "reports", "session", "user", "verification",
    ]);
    expect(tables.rows.every((row) => row.primary_key)).toBe(true);
    const history = await target.client.query("SELECT * FROM drizzle.__drizzle_migrations");
    expect(history.rowCount).toBe(3);
  });

  it.each([
    ["利用者の存在", "INSERT INTO identity_records (user_id, private_real_name, school_reference) VALUES ($1, '架空', 'test')", [randomUUID()]],
    ["本人の公開プロフィール版", "INSERT INTO profiles (user_id, current_revision_id) VALUES ($1, $2)", [other, revision]],
    ["本人の審査版", "INSERT INTO profile_reviews (user_id, revision_id) VALUES ($1, $2)", [other, revision]],
    ["質問の存在", "INSERT INTO qa_responses (question_id, author_id, kind, body_markdown, author_label) VALUES ($1, $2, 'answer', '本文', '架空')", [randomUUID(), user]],
    ["同じ質問の親回答", "INSERT INTO qa_responses (question_id, author_id, kind, parent_response_id, body_markdown, author_label) VALUES ($1, $2, 'reply', $3, '本文', '架空')", [secondQuestion, user, answer]],
    ["お知らせの公開版", "INSERT INTO notices (author_id, origin_kind, public_revision_id) VALUES ($1, 'school', $2)", [other, noticeRevision]],
    ["お知らせの申請版", "INSERT INTO notice_requests (notice_id, revision_id, request_kind) VALUES ($1, $2, 'new')", [notice, otherNoticeRevision]],
    ["イベントの公開版", "INSERT INTO events (author_id, origin_kind, public_revision_id) VALUES ($1, 'staff', $2)", [other, eventRevision]],
    ["イベントの申請版", "INSERT INTO event_requests (event_id, revision_id, request_kind) VALUES ($1, $2, 'new')", [event, otherEventRevision]],
  ] as const)("外部キーが不正参照を拒否する: %s", async (_label, query, values) => {
    await expect(probe(query, [...values])).rejects.toMatchObject({ code: "23503" });
  });

  it.each([
    ["在校生以外の卒業予定", "UPDATE community_users SET is_graduating=true WHERE user_id=$1", [other]],
    ["在校生の学校管理者", "UPDATE community_users SET school_manager=true WHERE user_id=$1", [user]],
    ["不明な所属", "UPDATE community_users SET base_role='unknown' WHERE user_id=$1", [user]],
    ["自己を親とする回答", "UPDATE qa_responses SET parent_response_id=id, kind='reply' WHERE id=$1", [answer]],
    ["親のない返信", "UPDATE qa_responses SET kind='reply' WHERE id=$1", [answer]],
    ["終了が開始以前", "UPDATE event_revisions SET ends_at=starts_at WHERE id=$1", [eventRevision]],
    ["対象が複数の通報", "INSERT INTO report_targets (kind, subject_user_id, question_id) VALUES ('account', $1, $2)", [user, question]],
    ["種別と異なる通報対象", "INSERT INTO report_targets (kind, subject_user_id) VALUES ('question', $1)", [user]],
    ["対象がない通知", "INSERT INTO notifications (recipient_id, kind, event_key, public_message) VALUES ($1, 'qa_hidden', 'test', '確認')", [user]],
    ["実行者のない監査", "INSERT INTO audit_logs (action_type, target_type, target_id) VALUES ('test', 'test', 'test')", []],
    ["不正な版番号", "UPDATE profile_revisions SET revision_no=0 WHERE id=$1", [revision]],
  ] as const)("CHECKが不正な組合せを拒否する: %s", async (_label, query, values) => {
    await expect(probe(query, [...values])).rejects.toMatchObject({ code: "23514" });
  });

  it.each([
    ["profile_reviews", "user_id", "revision_id", user, revision],
    ["notice_requests", "notice_id", "revision_id", notice, noticeRevision],
    ["event_requests", "event_id", "revision_id", event, eventRevision],
  ])("%sは同じ本体のpendingを1件に限定し、確定済み履歴は複数保持する", async (table, ownerColumn, revisionColumn, ownerId, revisionId) => {
    const kind = table === "profile_reviews" ? "" : ", request_kind";
    const kindValue = table === "profile_reviews" ? "" : ", 'new'";
    const insert = `INSERT INTO ${table} (${ownerColumn}, ${revisionColumn}, status, reviewer_id, decided_at${kind}) VALUES ($1, $2, $3, $4, $5${kindValue})`;
    await target.client.query("BEGIN");
    try {
      for (let i = 0; i < 2; i++) await target.client.query(insert, [ownerId, revisionId, "approved", other, new Date()]);
      await target.client.query(insert, [ownerId, revisionId, "pending", null, null]);
      await expect(target.client.query(insert, [ownerId, revisionId, "pending", null, null])).rejects.toMatchObject({ code: "23505" });
    } finally { await target.client.query("ROLLBACK"); }
  });

  it("公開・申請の正しい複合参照を受け付ける", async () => {
    await expect(probe("UPDATE notices SET public_revision_id=$1 WHERE id=$2", [noticeRevision, notice])).resolves.toBeUndefined();
    await expect(probe("UPDATE events SET public_revision_id=$1 WHERE id=$2", [eventRevision, event])).resolves.toBeUndefined();
    await expect(probe("INSERT INTO profiles (user_id, current_revision_id) VALUES ($1, $2)", [user, revision])).resolves.toBeUndefined();
    await expect(probe("INSERT INTO qa_responses (question_id, author_id, kind, parent_response_id, body_markdown, author_label) VALUES ($1, $2, 'reply', $3, '本文', '架空')", [question, user, answer])).resolves.toBeUndefined();
  });

  it.each([
    ["認証email", 'UPDATE "user" SET email=$1 WHERE id=$2', [`${user}@example.invalid`, other]],
    ["カテゴリコード", "INSERT INTO qa_categories (code, name) VALUES ('test', '重複')", []],
    ["プロフィール版番号", "INSERT INTO profile_revisions (user_id, revision_no, display_name) VALUES ($1, 1, '重複')", [user]],
    ["お知らせ版番号", "INSERT INTO notice_revisions (notice_id, revision_no, title, body, category_code) VALUES ($1, 1, '題', '本文', 'test')", [notice]],
    ["イベント版番号", "INSERT INTO event_revisions (event_id, revision_no, title, description, starts_at, format) VALUES ($1, 1, '催し', '本文', now(), 'online')", [event]],
  ] as const)("UNIQUEが重複を拒否する: %s", async (_label, query, values) => {
    await expect(probe(query, [...values])).rejects.toMatchObject({ code: "23505" });
  });

  it("通報案件は未終了1件、通知と再送キーは利用者ごとに一意となる", async () => {
    await target.client.query("BEGIN");
    try {
      const reportTarget = (await target.client.query("INSERT INTO report_targets (kind, subject_user_id) VALUES ('account', $1) RETURNING id", [user])).rows[0].id;
      await target.client.query("INSERT INTO report_cases (target_id, handoff_pending) VALUES ($1, true)", [reportTarget]);
      await target.client.query("SAVEPOINT duplicates");
      await expect(target.client.query("INSERT INTO report_cases (target_id, handoff_pending) VALUES ($1, true)", [reportTarget])).rejects.toMatchObject({ code: "23505" });
      await target.client.query("ROLLBACK TO SAVEPOINT duplicates");
      await target.client.query("INSERT INTO notifications (recipient_id, kind, qa_question_id, event_key, public_message) VALUES ($1, 'qa_hidden', $2, 'same-key', '通知')", [user, question]);
      await expect(target.client.query("INSERT INTO notifications (recipient_id, kind, qa_question_id, event_key, public_message) VALUES ($1, 'qa_hidden', $2, 'same-key', '通知')", [user, question])).rejects.toMatchObject({ code: "23505" });
      await target.client.query("ROLLBACK TO SAVEPOINT duplicates");
      await target.client.query("INSERT INTO operation_receipts (actor_id, request_key, request_hash, result_type, result_id, result_state, response_status) VALUES ($1, 'same-key', 'hash', 'test', 'test', 'done', 200)", [user]);
      await expect(target.client.query("INSERT INTO operation_receipts (actor_id, request_key, request_hash, result_type, result_id, result_state, response_status) VALUES ($1, 'same-key', 'hash', 'test', 'test', 'done', 200)", [user])).rejects.toMatchObject({ code: "23505" });
    } finally { await target.client.query("ROLLBACK"); }
  });

  it("一覧・審査・通知・管理の索引が設計書どおりの先頭列と順序を持つ", async () => {
    const indexes = await target.client.query<{ name: string; columns: string[]; predicate: string | null; unique: boolean }>(`SELECT c.relname AS name,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, position)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.position) AS columns,
      pg_get_expr(i.indpred, i.indrelid) AS predicate, i.indisunique AS unique
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`);
    const byName = new Map(indexes.rows.map((row) => [row.name, row]));
    const expected = {
      qa_questions_category_date: ["category_id", "created_at", "id"],
      qa_questions_author_date: ["author_id", "created_at", "id"],
      qa_questions_public_date: ["created_at", "id"],
      qa_responses_question_date: ["question_id", "created_at", "id"],
      qa_responses_parent: ["parent_response_id", "question_id"],
      qa_responses_author_date: ["author_id", "created_at", "id"],
      notices_author_date: ["author_id", "updated_at", "id"],
      notices_public_date: ["first_published_at", "id"],
      notice_requests_status_date: ["status", "submitted_at", "id"],
      notice_requests_notice_date: ["notice_id", "submitted_at", "id"],
      events_author_date: ["author_id", "updated_at", "id"],
      events_public_date: ["first_published_at", "id"],
      event_requests_status_date: ["status", "submitted_at", "id"],
      event_requests_event_date: ["event_id", "submitted_at", "id"],
      event_revisions_start_date: ["starts_at", "id"],
      profile_reviews_status_date: ["status", "submitted_at", "id"],
      profile_reviews_user_date: ["user_id", "submitted_at", "id"],
      account_restrictions_user_date: ["user_id", "created_at", "id"],
      manager_role_changes_user_date: ["user_id", "created_at", "id"],
      graduation_changes_user_date: ["user_id", "created_at", "id"],
      reports_case_date: ["case_id", "created_at", "id"],
      reports_reporter: ["reporter_id"],
      report_cases_assignee_status: ["assignee_id", "status"],
      report_cases_target: ["target_id"],
      report_actions_case_date: ["case_id", "created_at", "id"],
      evidence_snapshots_target_date: ["target_id", "captured_at", "id"],
      report_case_evidence_snapshot: ["evidence_id"],
      notifications_recipient_date: ["recipient_id", "created_at", "id"],
      notifications_recipient_unread: ["recipient_id"],
      audit_logs_date: ["created_at", "id"],
      audit_logs_target_date: ["target_type", "target_id", "created_at"],
    };
    for (const [name, columns] of Object.entries(expected)) expect(byName.get(name)?.columns, name).toEqual(columns);
    for (const name of ["qa_questions_public_date", "notices_public_date", "events_public_date", "notifications_recipient_unread"]) {
      expect(byName.get(name)?.predicate, name).toBeTruthy();
    }
    for (const [name, columns] of Object.entries({ profile_reviews_one_pending: ["user_id"], notice_requests_one_pending: ["notice_id"], event_requests_one_pending: ["event_id"], report_cases_one_active: ["target_id"] })) {
      expect(byName.get(name)).toMatchObject({ columns, unique: true });
      expect(byName.get(name)?.predicate).toBeTruthy();
    }
  });
});
