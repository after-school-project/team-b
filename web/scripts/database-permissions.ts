import nextEnv from "@next/env";
import { Client } from "pg";
import { managementDatabaseConfig } from "./lib/management-config";
import { applicationRoleName, grantApplicationRole } from "./lib/database-management";

async function main() {
  nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
  if (process.argv.length > 2) throw new Error("権限設定は追加引数を受け付けません。");
  const role = applicationRoleName(process.env.APP_DATABASE_ROLE);
  const client = new Client(managementDatabaseConfig(process.env));
  try {
    await client.connect();
    await grantApplicationRole(client, role);
    console.info("アプリ用ロールの権限を設定しました。");
  } finally {
    await client.end();
  }
}

main().catch(() => {
  console.error("権限設定に失敗しました。管理用接続、APP_DATABASE_ROLE、専用ロールの所有権・所属を確認してください。");
  process.exitCode = 1;
});
