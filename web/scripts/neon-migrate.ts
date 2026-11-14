import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { neonMigrationMode, neonMigrationTarget } from "./lib/neon-migration";

async function main() {
  // Compose専用の環境変数だけを使い、通常開発用の.envを読み込まない。
  const mode = neonMigrationMode(process.argv.slice(2));
  const target = neonMigrationTarget(process.env);
  console.info(`Neon接続先: ${target.host} / ${target.database}`);
  const client = new Client({
    connectionString: target.connectionString,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 60_000,
    application_name: "team-b-neon-migration",
  });
  try {
    await client.connect();
    const result = await client.query<{ database: string }>("SELECT current_database() AS database");
    if (result.rows[0].database !== target.database) throw new Error("unexpected_database");
    if (mode === "--apply") {
      // 同じ実行経路からの並行マイグレーションを直列化する。切断時に自動解放。
      await client.query("SELECT pg_advisory_lock($1)", [7249352026]);
      await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
      console.info("Neonマイグレーションの適用が完了しました（seed・開発用権限設定は実行しません）。");
    }
    const tables = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    console.info(`接続確認成功。publicテーブル数: ${tables.rows[0].count}`);
  } catch {
    // DBドライバーの例外や接続URLには秘密値が含まれる可能性があるため出力しない。
    throw new Error("Neonへの接続・確認またはマイグレーションに失敗しました。接続先、認証情報、DB権限とNeon側の状態を確認してください。");
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Neon管理コマンドに失敗しました。");
  process.exitCode = 1;
});
