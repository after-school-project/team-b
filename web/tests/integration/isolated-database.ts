import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/lib/test-database";

/**
 * プールの全接続が実際に閉じるまで待つ。
 * `pool.end()` は接続の切断完了を待たずに解決する。直後に `dispose()` の `DROP DATABASE ... WITH (FORCE)` を
 * 実行すると、切断中の接続がサーバーに切られ（57P01）、受け手のないエラーとしてテスト全体が失敗する。
 * 各接続の切断完了時に出る `remove` を数えてから返す。
 */
export async function endPool(pool: Pool | undefined): Promise<void> {
  if (!pool || pool.ending || pool.ended) return;
  const open = pool.totalCount;
  const closed = new Promise<void>((resolve) => {
    if (open === 0) return resolve();
    let removed = 0;
    pool.on("remove", () => {
      removed += 1;
      if (removed === open) resolve();
    });
  });
  await pool.end();
  await closed;
}

// 明示的なテストDBに接続できた場合だけ、同じ使い捨てクラスタに検証用DBを作る。
export async function isolatedDatabase(name = `issue5_${randomUUID().replaceAll("-", "")}`, owner?: string) {
  if (!/^(issue5_[a-f0-9]{32}|team_b_dev)$/.test(name)) throw new Error("Unsafe test database name");
  if (owner && !/^[a-z][a-z0-9_]*$/.test(owner)) throw new Error("Unsafe owner name");
  const url = new URL(requireTestDatabaseUrl(process.env));
  if (!["db", "localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/team_b_test" || url.search || url.hash) {
    throw new Error("DB作成を伴うテストには、使い捨てローカル team_b_test が必要です。");
  }
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"${owner ? ` OWNER "${owner}"` : ""}`);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return {
    client, admin, url,
    async dispose() {
      await client.end();
      // CREATE DATABASEが成功した、この検証専用のDBだけを削除する。
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}
