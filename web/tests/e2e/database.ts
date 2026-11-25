import { Client } from "pg";

/**
 * 画面からはまだ変更できない利用者の状態（権限の解除など）を、E2E専用の使い捨てDBで直接用意する。
 * 接続には、アプリと同じ `DATABASE_URL`（アプリ用ロール）を使う。準備手順は docs/development/quality-and-poc.md を参照する。
 *
 * 利用者の状態を書き換え、再公開申請と通知を削除するため、使い捨てDBとして起動したサーバーだけで実行する。
 * 接続先は接続する前に確認する。さらに、接続URLだけでは、ポートを公開した通常の開発DBと区別できないため、サーバー自身の `cluster_name` でも判定する。
 * 既定値は空で、E2E専用のDBを起動するときのオプション（`-c cluster_name=team-b-e2e`）でだけ設定する。
 */
export const disposableClusterName = "team-b-e2e";

class NotDisposableDatabase extends Error {}

const refusal = "DATABASE_URL の接続先がE2E専用の使い捨てDBではないため、状態を変更しません。"
  + "docs/development/quality-and-poc.md の手順でDBを起動してください。";

/**
 * 接続URLが、手順どおりに起動したE2E用DBのアプリ用ロールの接続だけを表すか。
 * `pg` はクエリーの `host`・`port`・`user` などで接続先を上書きし、ポートの省略時は `PGPORT` を使うため、クエリーと
 * ポートの省略を認めない。解析エラーは接続情報を含み得るため、例外にせず拒否する。
 */
function isE2eDatabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "postgresql:" && url.hostname === "127.0.0.1" && url.port === "5432" &&
      url.pathname === "/team_b_dev" && url.username === "team_b_app" && url.password !== "" &&
      url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

async function withDatabase<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("E2E用DBの DATABASE_URL を設定してください。");
  // 別のサーバーへ資格情報を送らないよう、接続先は接続する前に確認する。
  if (!isE2eDatabaseUrl(connectionString)) throw new NotDisposableDatabase(refusal);
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const { rows } = await client.query<{ name: string }>("SELECT current_setting('cluster_name') AS name");
    if (rows[0]?.name !== disposableClusterName) {
      throw new NotDisposableDatabase(refusal);
    }
    return await run(client);
  } catch (error) {
    if (error instanceof NotDisposableDatabase) throw error;
    // 接続情報を含み得る元の例外は出さない。
    throw new Error(`E2E用DBの操作に失敗しました（${(error as { code?: string }).code ?? "接続エラー"}）。`);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function userIdOf(username: string): Promise<string> {
  const id = await withDatabase(async (client) =>
    (await client.query<{ id: string }>('SELECT id FROM "user" WHERE username = $1', [username])).rows[0]?.id);
  if (!id) throw new Error(`${username} がE2E用DBにありません。`);
  return id;
}

/** 利用者の公開状態・アプリ管理者の権限を設定する。 */
export async function setUserState(username: string, state: { profileState?: "public" | "hidden"; appManager?: boolean }) {
  const userId = await userIdOf(username);
  await withDatabase((client) => client.query(
    `UPDATE community_users SET profile_state = coalesce($2, profile_state), app_manager = coalesce($3, app_manager)
      WHERE user_id = $1`,
    [userId, state.profileState ?? null, state.appManager ?? null],
  ));
}

/** 再公開申請と、それに関する通知を消し、公開中の状態に戻す（同じDBで繰り返し実行できるようにする）。 */
export async function resetProfileReviews(username: string) {
  const userId = await userIdOf(username);
  await withDatabase(async (client) => {
    await client.query("DELETE FROM notifications WHERE recipient_id = $1 AND profile_review_id IS NOT NULL", [userId]);
    await client.query("DELETE FROM profile_reviews WHERE user_id = $1", [userId]);
    await client.query("UPDATE community_users SET profile_state = 'public' WHERE user_id = $1", [userId]);
  });
}
