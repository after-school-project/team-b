import nextEnv from "@next/env";
import { Client } from "pg";
import { databaseConfig } from "../src/db/config";
import { localDatabaseTarget, localSetupMode, setupLocalDatabase } from "./lib/local-database";

async function main() {
  nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
  const mode = localSetupMode(process.argv.slice(2));
  localDatabaseTarget(process.env, mode === "reset");
  const client = new Client(databaseConfig(process.env, "DATABASE_URL_DIRECT"));
  try {
    await client.connect();
    const created = await setupLocalDatabase(client, process.env, mode);
    console.info(`Development database ready. Created ${created} fixture accounts.`);
  } finally {
    await client.end();
  }
}

main().catch(() => {
  console.error("開発DBの初期化に失敗しました。ローカル専用設定、管理用接続とDBの状態を確認してください（秘密値・DB例外は出力しません）。");
  process.exitCode = 1;
});
