import { Client } from "pg";

/**
 * 画面からはまだ変更できない利用者の状態（権限の解除など）を、E2E専用の使い捨てDBで直接用意する。
 * 接続には、アプリと同じ `DATABASE_URL`（アプリ用ロール）を使う。準備手順は docs/development/quality-and-poc.md を参照する。
 */

async function withDatabase<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("E2E用DBの DATABASE_URL を設定してください。");
  const { hostname, pathname } = new URL(connectionString);
  // 利用者の状態を書き換えるため、ホストのE2E用DB以外では実行しない。
  if (hostname !== "127.0.0.1" || pathname !== "/team_b_dev") throw new Error("E2E用のローカルDBだけで実行できます。");
  const client = new Client({ connectionString });
  try {
    await client.connect();
    return await run(client);
  } catch (error) {
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
