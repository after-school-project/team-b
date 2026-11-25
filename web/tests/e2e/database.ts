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

/** 手順どおりに起動したE2E用DBの、アプリ用ロールの接続先。 */
const e2eDatabase = { host: "127.0.0.1", port: 5432, database: "team_b_dev", user: "team_b_app" } as const;

/**
 * 接続URLがE2E用DBの接続先だけを表すことを確認し、`pg` に渡す接続設定を返す。それ以外は null。
 * URL の文字列を `pg` に渡すと、クエリーによる上書きや、先頭の空白の解釈の違いで、確認した接続先と別のサーバーへ接続し得る。
 * そのため、接続先は固定値、パスワードは確認した URL から取り出した値だけを渡す。
 * 解析エラーは接続情報を含み得るため、例外にせず拒否する。
 */
function e2eDatabaseConfig(value: string) {
  try {
    const url = new URL(value);
    const password = decodeURIComponent(url.password);
    const matches = url.protocol === "postgresql:" && url.hostname === e2eDatabase.host &&
      url.port === String(e2eDatabase.port) && url.pathname === "/" + e2eDatabase.database &&
      url.username === e2eDatabase.user && password !== "" && url.search === "" && url.hash === "";
    return matches ? { ...e2eDatabase, password } : null;
  } catch {
    return null;
  }
}

async function withDatabase<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("E2E用DBの DATABASE_URL を設定してください。");
  // 別のサーバーへ資格情報を送らないよう、接続先は接続する前に確認する。
  const config = e2eDatabaseConfig(connectionString);
  if (!config) throw new NotDisposableDatabase(refusal);
  const client = new Client(config);
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

type UserState = {
  profileState?: "public" | "hidden"; appManager?: boolean; baseRole?: "student" | "alumni"; isGraduating?: boolean;
};

/** 利用者の公開状態・アプリ管理者の権限・所属区分を設定する。 */
export async function setUserState(username: string, state: UserState) {
  const userId = await userIdOf(username);
  await withDatabase((client) => client.query(
    `UPDATE community_users SET profile_state = coalesce($2, profile_state), app_manager = coalesce($3, app_manager),
      base_role = coalesce($4, base_role), is_graduating = coalesce($5, is_graduating) WHERE user_id = $1`,
    [userId, state.profileState ?? null, state.appManager ?? null, state.baseRole ?? null, state.isGraduating ?? null],
  ));
}

const temporaryPrefix = "e2e-graduating-";

/** 卒業予定の在校生を、指定した学科で一時的に作る。終わったら `removeGraduatingStudents` で消す。 */
export async function createGraduatingStudents(department: string, count: number) {
  await withDatabase(async (client) => {
    for (let index = 0; index < count; index++) {
      const userId = temporaryPrefix + String(index).padStart(3, "0");
      await client.query('INSERT INTO "user" (id, name, email) VALUES ($1, $1, $2)', [userId, `${userId}@example.invalid`]);
      await client.query(`INSERT INTO community_users (user_id, base_role, is_graduating, eligibility_status, provisioning_status)
        VALUES ($1, 'student', true, 'verified', 'ready')`, [userId]);
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO profile_revisions (user_id, revision_no, display_name, department) VALUES ($1, 1, $1, $2) RETURNING id",
        [userId, department],
      );
      await client.query("INSERT INTO profiles (user_id, current_revision_id) VALUES ($1, $2)", [userId, rows[0].id]);
    }
  });
}

/** 別の更新があったときと同じように、利用者の版番号だけを進める。 */
export async function bumpUserVersion(userId: string) {
  await withDatabase((client) => client.query("UPDATE community_users SET version = version + 1 WHERE user_id = $1", [userId]));
}

export async function removeGraduatingStudents() {
  await withDatabase(async (client) => {
    for (const table of ["graduation_changes", "profiles", "profile_revisions", "community_users"]) {
      await client.query(`DELETE FROM ${table} WHERE user_id LIKE $1`, [temporaryPrefix + "%"]);
    }
    await client.query('DELETE FROM "user" WHERE id LIKE $1', [temporaryPrefix + "%"]);
  });
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

type NewQuestion = {
  title: string; body?: string; category?: string; resolution?: "open" | "resolved"; hidden?: boolean; deleted?: boolean;
};

/** Q&Aの質問を、本文の末尾に目印を付けて作り、IDを渡した順に返す。終わったら `removeQuestions` で消す。 */
export async function createQuestions(marker: string, questions: NewQuestion[]): Promise<string[]> {
  const authorId = await userIdOf("poc_s001");
  return withDatabase(async (client) => {
    const ids: string[] = [];
    for (const question of questions) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO qa_questions (author_id, category_id, title, body_markdown, author_label, resolution, forced_hidden_at, deleted_at)
        VALUES ($1, (SELECT id FROM qa_categories WHERE code = $2), $3, $4, 'e2eの投稿者名', $5,
          CASE WHEN $6 THEN now() END, CASE WHEN $7 THEN now() END) RETURNING id`,
        [authorId, question.category ?? "learning", question.title, `${question.body ?? "本文"}\n\n${marker}`,
          question.resolution ?? "open", question.hidden ?? false, question.deleted ?? false],
      );
      ids.push(rows[0].id);
    }
    return ids;
  });
}

export async function removeQuestions(marker: string) {
  await withDatabase((client) => client.query(
    "DELETE FROM qa_questions WHERE body_markdown LIKE '%' || $1 AND author_label = 'e2eの投稿者名'", [marker]));
}
