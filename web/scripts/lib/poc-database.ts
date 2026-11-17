import { randomUUID } from "node:crypto";
import type { Client } from "pg";

// 専用の接続上で実行する。業務テーブル・既存データ・認証セッションには書き込まない。
export async function verifyDatabaseRoundTrip(client: Client): Promise<void> {
  const value = randomUUID();
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("CREATE TEMPORARY TABLE poc_connection_probe (value uuid NOT NULL) ON COMMIT DROP");
    await client.query("INSERT INTO pg_temp.poc_connection_probe (value) VALUES ($1)", [value]);
    const result = await client.query<{ value: string }>("SELECT value FROM pg_temp.poc_connection_probe");
    if (result.rows.length !== 1 || result.rows[0].value !== value) throw new Error("probe_failed");
    await client.query("COMMIT");
    const cleanup = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('pg_temp.poc_connection_probe')::text AS relation",
    );
    if (cleanup.rows[0].relation !== null) throw new Error("probe_cleanup_failed");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
