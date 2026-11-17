import nextEnv from "@next/env";
import { Client } from "pg";
import { managementDatabaseConfig } from "./lib/management-config";
import { migrateDatabase } from "./lib/database-management";

async function main() {
  nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
  if (process.argv.length > 2) throw new Error("マイグレーションは追加引数を受け付けません。");
  const client = new Client(managementDatabaseConfig(process.env));
  try {
    await client.connect();
    await migrateDatabase(client);
    console.info("管理用接続でマイグレーションを適用しました。");
  } finally {
    await client.end();
  }
}

main().catch(() => {
  console.error("マイグレーションに失敗しました。DATABASE_URL_DIRECT、TLS、管理用ロールの権限を確認してください。");
  process.exitCode = 1;
});
