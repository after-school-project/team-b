import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireTestDatabaseUrl } from "../../scripts/lib/test-database";

const client = new Client({
  connectionString: requireTestDatabaseUrl(process.env),
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
});
const applicant = randomUUID();
const reviewer = randomUUID();
let revision: string;

beforeAll(async () => {
  await client.connect();
  // 既存2本を適用したDBから、追加マイグレーションで更新できることを確認する。
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
    entries: { tag: string }[];
  };
  await client.query("BEGIN");
  for (const entry of journal.entries.slice(0, 2)) {
    await client.query(readFileSync(`drizzle/${entry.tag}.sql`, "utf8"));
  }
  await client.query('INSERT INTO "user" (id, name, email) VALUES ($1, $1, $2), ($3, $3, $4)',
    [applicant, `${applicant}@example.invalid`, reviewer, `${reviewer}@example.invalid`]);
  await client.query("INSERT INTO community_users (user_id, base_role) VALUES ($1, 'student'), ($2, 'staff')", [applicant, reviewer]);
  revision = (await client.query<{ id: string }>(
    "INSERT INTO profile_revisions (user_id, revision_no, display_name) VALUES ($1, 1, 'Review fixture') RETURNING id", [applicant],
  )).rows[0].id;
  await client.query("INSERT INTO profile_reviews (user_id, revision_id) VALUES ($1, $2)", [applicant, revision]);
  for (const entry of journal.entries.slice(2)) {
    await client.query(readFileSync(`drizzle/${entry.tag}.sql`, "utf8"));
  }
});

afterAll(async () => {
  await client.query("ROLLBACK");
  await client.end();
});

async function insertReview(values: { status: string; reviewer: string | null; decidedAt: Date | null; reason: string | null }) {
  await client.query("SAVEPOINT profile_review_probe");
  try {
    await client.query("DELETE FROM profile_reviews WHERE user_id = $1", [applicant]);
    await client.query(`INSERT INTO profile_reviews
      (user_id, revision_id, status, reviewer_id, decided_at, decision_reason)
      VALUES ($1, $2, $3, $4, $5, $6)`,
    [applicant, revision, values.status, values.reviewer, values.decidedAt, values.reason]);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT profile_review_probe");
  }
}

describe("プロフィール審査のDB制約", () => {
  it.each([
    { status: "pending", reviewer: null, decidedAt: null, reason: null },
    { status: "approved", reviewer, decidedAt: new Date(), reason: null },
    { status: "rejected", reviewer, decidedAt: new Date(), reason: "公開項目の修正が必要です。" },
  ])("正しい審査状態を保存できる: $status", async (values) => {
    await expect(insertReview(values)).resolves.toBeUndefined();
  });

  it.each([
    { status: "rejected", reviewer, decidedAt: new Date(), reason: null },
    { status: "rejected", reviewer, decidedAt: new Date(), reason: "   " },
    { status: "rejected", reviewer, decidedAt: new Date(), reason: "\t\r\n" },
    { status: "approved", reviewer: null, decidedAt: new Date(), reason: null },
    { status: "approved", reviewer, decidedAt: null, reason: null },
    { status: "rejected", reviewer: null, decidedAt: new Date(), reason: "理由" },
    { status: "rejected", reviewer, decidedAt: null, reason: "理由" },
    { status: "pending", reviewer, decidedAt: null, reason: null },
    { status: "pending", reviewer: null, decidedAt: new Date(), reason: null },
    { status: "pending", reviewer: null, decidedAt: null, reason: "未確定の理由" },
  ])("不整合な状態・審査者・日時・理由を拒否する: $status", async (values) => {
    await expect(insertReview(values)).rejects.toMatchObject({ code: "23514" });
  });

  it("テーブル数を維持し、審査・利用者別履歴の索引を作成する", async () => {
    const tables = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    expect(tables.rows[0].count).toBe(31);
    const indexes = await client.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1::text[]) ORDER BY indexname",
      [["account_restrictions_user_date", "profile_reviews_status_date", "profile_reviews_user_date"]],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "account_restrictions_user_date", "profile_reviews_status_date", "profile_reviews_user_date",
    ]);
  });
});
