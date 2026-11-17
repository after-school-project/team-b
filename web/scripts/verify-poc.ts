import { readFileSync } from "node:fs";
import { Client } from "pg";
import { neonMigrationTarget } from "./lib/neon-migration";
import { verifyApplicationRoundTrip, verifyDatabaseRoundTrip } from "./lib/poc-database";
import { requireApplicationRole } from "../src/db/permissions";
import { databaseConfig } from "../src/db/config";
import { productionPocConfig, shouldVerifyProduction } from "./lib/poc-environment";

async function main() {
  const args = process.argv.slice(2);
  const databaseOnly = args.length === 1 && args[0] === "--database-only";
  if (args.length && !databaseOnly) throw new Error("Usage: verify-poc.ts [--database-only]");
  if (databaseOnly && process.env.VERCEL) throw new Error("Vercelでは設定検証を省略できません。");
  if (!databaseOnly && !shouldVerifyProduction(process.env)) {
    console.info("PoC接続確認を省略しました（Vercel Production以外）。PoCの秘密値は必要ありません。");
    return;
  }
  const { connectionString } = databaseOnly
    ? neonMigrationTarget(process.env)
    : productionPocConfig(process.env);
  // NeonのTLSはプロキシで終端する。pg_stat_sslはクライアント側TLSの証拠にしない。
  // 証明書とホスト名を検証する接続に固定し、その接続成功を確認する。
  const client = new Client({
    ...databaseConfig({ DATABASE_URL: connectionString }),
    connectionTimeoutMillis: 15_000,
    statement_timeout: 5_000,
    query_timeout: 10_000,
    application_name: "team-b-poc-verification",
  });
  let phase = "connect";
  try {
    await client.connect();
    phase = "tables";
    const tables = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    if (tables.rows[0].count !== 31) throw new Error("schema_mismatch");
    if (databaseOnly) {
      phase = "migrations";
      const migrations = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations");
      const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: unknown[] };
      if (migrations.rows[0].count !== journal.entries.length) throw new Error("migration_mismatch");
      console.info(`管理用接続: マイグレーション${migrations.rows[0].count}件を確認しました。`);
    }
    phase = "round-trip";
    if (databaseOnly) {
      await verifyDatabaseRoundTrip(client);
    } else {
      phase = "application-role";
      await requireApplicationRole(client);
      phase = "round-trip";
      await verifyApplicationRoundTrip(client);
    }
    console.info("PoC DB確認成功: TLS有効、31テーブル、書き込み・読み取り・後片付け成功。");
    if (databaseOnly) console.info("ローカルから管理用接続を確認しました。Vercel上のアプリ用接続・認証設定は別途確認が必要です。");
  } catch {
    // ドライバー例外には接続先・SQL・秘密値が含まれる可能性がある。
    throw new Error(`PoC DB確認に失敗しました（段階: ${phase}）。接続、TLS、権限、マイグレーションを確認してください（秘密値・DB例外は出力しません）。`);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "PoC環境確認に失敗しました。");
  process.exitCode = 1;
});
