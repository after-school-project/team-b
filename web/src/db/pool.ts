import "server-only";
import { Pool } from "pg";
import { databaseConfig } from "./config";

// Next.jsの開発時再読み込みでも、プロセス内のプールを共有する。
const shared = globalThis as typeof globalThis & { teamBDatabasePool?: Pool };

export function applicationPool() {
  if (!shared.teamBDatabasePool) {
    const pool = new Pool(databaseConfig(process.env));
    pool.on("error", () => {
      console.error("DBの待機接続が切断されました。次の接続で再試行します。");
    });
    shared.teamBDatabasePool = pool;
  }
  return shared.teamBDatabasePool;
}
