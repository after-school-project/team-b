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

/** 質問に回答を1件作る。質問と一緒に `removeQuestions` で消える。 */
export async function createAnswer(questionId: string, username: string, body: string): Promise<string> {
  return (await createAnswers(questionId, username, [body]))[0];
}

/** 質問に回答を、渡した順に作成日時が古い順になるよう作る。質問と一緒に `removeQuestions` で消える。 */
export async function createAnswers(questionId: string, username: string, bodies: string[]): Promise<string[]> {
  const authorId = await userIdOf(username);
  return withDatabase(async (client) => {
    const ids: string[] = [];
    for (const [index, body] of bodies.entries()) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO qa_responses (question_id, author_id, kind, body_markdown, author_label, created_at, updated_at)
        VALUES ($1, $2, 'answer', $3, 'e2eの回答者名', now() - make_interval(secs => $4), now() - make_interval(secs => $4))
        RETURNING id`, [questionId, authorId, body, bodies.length - index]);
      ids.push(rows[0].id);
    }
    return ids;
  });
}

/** 目印の付いた質問を消す。回答等と、質問・回答等への通知も先に消す。 */
export async function removeQuestions(marker: string, username?: string) {
  const questions = `SELECT id FROM qa_questions WHERE right(body_markdown, length($1)) = $1
      AND (($2::text IS NULL AND author_label = 'e2eの投稿者名')
        OR author_id = (SELECT id FROM "user" WHERE username = $2))`;
  const responses = `SELECT id FROM qa_responses WHERE question_id IN (${questions})`;
  await withDatabase(async (client) => {
    const values = [marker, username ?? null];
    await client.query(`DELETE FROM notifications WHERE qa_question_id IN (${questions}) OR qa_response_id IN (${responses})`, values);
    await client.query(`DELETE FROM qa_responses WHERE id IN (${responses})`, values);
    await client.query(`DELETE FROM qa_questions WHERE id IN (${questions})`, values);
  });
}

/** テストで作った質問への通報と証拠を片付ける。監査ログはアプリ用ロールでは消去できない。 */
export async function removeQuestionReports(questionId: string) {
  const targets = "SELECT id FROM report_targets WHERE question_id = $1";
  const cases = `SELECT id FROM report_cases WHERE target_id IN (${targets})`;
  await withDatabase(async (client) => {
    await client.query("BEGIN");
    for (const table of ["report_case_evidence", "report_actions", "reports"]) {
      await client.query(`DELETE FROM ${table} WHERE case_id IN (${cases})`, [questionId]);
    }
    await client.query(`DELETE FROM report_cases WHERE target_id IN (${targets})`, [questionId]);
    await client.query(`DELETE FROM evidence_snapshots WHERE target_id IN (${targets})`, [questionId]);
    await client.query("DELETE FROM report_targets WHERE question_id = $1", [questionId]);
    await client.query("COMMIT");
  });
}

type NewNotification = { message: string; read?: boolean; minutesAgo?: number };

/**
 * 利用者宛ての通知を、event_key に目印を付けて作る。対象は受信者本人のプロフィール（profile_hidden）にして、
 * ほかのデータに依存させない。終わったら `removeNotifications` で消す。
 */
export async function createNotifications(username: string, marker: string, notifications: NewNotification[]) {
  const recipientId = await userIdOf(username);
  await withDatabase(async (client) => {
    for (const [index, notification] of notifications.entries()) {
      await client.query(`INSERT INTO notifications (recipient_id, kind, profile_user_id, event_key, public_message, read_at, created_at)
        VALUES ($1, 'profile_hidden', $1, $2, $3, CASE WHEN $4 THEN now() END, now() - make_interval(mins => $5))`,
      [recipientId, `e2e-notification:${marker}:${index}`, notification.message, notification.read ?? false,
        notification.minutesAgo ?? index]);
    }
  });
}

export async function removeNotifications(marker: string) {
  await withDatabase((client) => client.query("DELETE FROM notifications WHERE event_key LIKE $1", [`e2e-notification:${marker}:%`]));
}
