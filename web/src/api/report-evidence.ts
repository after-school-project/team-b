import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { projectOptionalProfileFields } from "../auth/visibility";
import { qaQuestions, qaResponses } from "../db/content-schema";
import { evidenceSnapshots, reportCaseEvidence, reportCases, reportTargets } from "../db/moderation-schema";
import { communityUsers, profileRevisions, profiles } from "../db/schema";

/**
 * 通報証拠の保全（Issue #47 ③）。`commitMutation` の `execute` の中で、業務更新と同じトランザクションで呼ぶ。
 *
 * 通報対象の公開内容を `evidence_snapshots` に保存し、その対象の未終了案件と `report_case_evidence` で関連付ける。
 * 未終了案件がない対象では何もしない（DB・ER設計書 §5）。呼び出す時点は次のとおり。
 * - 通報の受付時（#15）：案件の作成・統合の後
 * - 証拠に関係する更新・削除の前（#8 のプロフィール保存、#9 の質問・回答等の編集・削除など）：更新する前の内容で呼ぶ
 *
 * 保存する内容は API設計書 §13 の EvidenceSnapshot に従い、公開内容だけにする。本人確認情報、管理権限、
 * 本人のみの任意プロフィール項目は保存しない。対象の行は、呼び出し側が本体としてロックしておく。
 *
 * プロフィールの公開版は、`profile_state=public` のときの現在版だけ（DB・ER設計書 §3）。非表示中は本人の保存で現在版が
 * 更新されても公開されない（再公開の承認前の版）ため、非表示中のプロフィールは保全しない。公開中の内容は、非表示にする
 * 処理（#8 API-US-05）で非表示にする前に保全する。アカウントの証拠でも、非表示中は未承認の版の表示名を保存しない。
 *
 * 質問・回答等も、一般の閲覧者に表示できる状態（強制非表示・削除済みでない。`visibleQuestion`・`visibleResponse` と同じ条件）
 * のときだけ保全する。強制非表示中も本人は編集できる（共通認可条件表 §2 QA-02）が、その内容は一度も公開されないため。
 * 公開中の内容は、本人の編集（#9 API-QA-05・10）、強制非表示にする処理（#10）、削除する処理（#9）で、変更する前に保全する。
 */

/**
 * 業務更新と同じトランザクション（`commitMutation` の `tx`）。案件の行ロックと複数の書き込みを1つのトランザクションで
 * 確定するため、通常の `db` は受け付けない（`rollback` を持つトランザクションだけを型で許可する）。
 */
export type CaseWriter = Pick<
  PgTransaction<NodePgQueryResultHKT, Record<string, unknown>, ExtractTablesWithRelations<Record<string, unknown>>>,
  "select" | "insert" | "update" | "execute" | "rollback"
>;

/**
 * 案件の行ロックを取得した後のDB時刻。案件の更新時刻・履歴・証拠の取得時刻に、SQLの値として使う。
 * `commitMutation` の `now` は案件をロックする前に取得するため、その間に別の処理が同じ案件を更新して確定すると、
 * `now` を書き込むと更新時刻が逆行する。ロックの取得後に読むことで、先に確定した更新より前の時刻にならない。
 * JavaScript の `Date`（ミリ秒）を経由するとDBのマイクロ秒が切り捨てられ、同じミリ秒内の先行更新より前になるため、
 * DBの精度のまま文字列で受け取り、`timestamptz` に戻して書き込む。
 */
export async function lockedCaseTime(tx: CaseWriter): Promise<SQL> {
  const { rows: [time] } = await tx.execute<{ at: string }>(sql`SELECT clock_timestamp()::text AS "at"`);
  return sql`${time.at}::timestamptz`;
}

/** 通報対象。プロフィール・アカウントは利用者ID、質問・回答等はそのID。 */
export type EvidenceTarget =
  | { kind: "question"; questionId: string }
  | { kind: "response"; responseId: string }
  | { kind: "profile"; userId: string }
  | { kind: "account"; userId: string };

type Snapshot = { sourceRevision: number; content: Record<string, unknown> };

/**
 * 対象を識別するキー。`report_targets` の行と、指定された対象を突き合わせる。
 * 質問・回答等のIDはUUIDで、PostgreSQL は大文字を含む入力も同じ値として検索し、小文字で返すため、小文字にそろえる。
 * 利用者IDは大文字と小文字を区別する文字列なので、そのまま使う。
 */
function targetKey(target: EvidenceTarget): string {
  switch (target.kind) {
    case "question": return `question:${target.questionId.toLowerCase()}`;
    case "response": return `response:${target.responseId.toLowerCase()}`;
    case "profile":
    case "account":
      return `${target.kind}:${target.userId}`;
  }
}

/**
 * 指定したすべての対象の `report_targets` の行を、1つの問い合わせで取得する。キーは `targetKey`。
 * 卒業区分の一括変更（最大100人のプロフィールとアカウント）でも、利用者行をロックしたまま対象ごとに往復しないため。
 */
async function findReportTargets(tx: CaseWriter, targets: readonly EvidenceTarget[]): Promise<Map<string, string>> {
  const ids = { question: new Set<string>(), response: new Set<string>(), profile: new Set<string>(), account: new Set<string>() };
  for (const target of targets) {
    if (target.kind === "question") ids.question.add(target.questionId);
    else if (target.kind === "response") ids.response.add(target.responseId);
    else ids[target.kind].add(target.userId);
  }
  const conditions: SQL[] = [];
  if (ids.question.size) conditions.push(and(eq(reportTargets.kind, "question"), inArray(reportTargets.questionId, [...ids.question]))!);
  if (ids.response.size) conditions.push(and(eq(reportTargets.kind, "response"), inArray(reportTargets.responseId, [...ids.response]))!);
  for (const kind of ["profile", "account"] as const) {
    if (ids[kind].size) conditions.push(and(eq(reportTargets.kind, kind), inArray(reportTargets.subjectUserId, [...ids[kind]]))!);
  }
  if (conditions.length === 0) return new Map();
  const rows = await tx.select({
    id: reportTargets.id, kind: reportTargets.kind, questionId: reportTargets.questionId,
    responseId: reportTargets.responseId, subjectUserId: reportTargets.subjectUserId,
  }).from(reportTargets).where(or(...conditions));
  const found = new Map<string, string>();
  for (const row of rows) {
    // 種類に対応する参照列は、report_targets_reference のCHECK制約で必ず設定されている。
    found.set(targetKey(row.kind === "question" ? { kind: "question", questionId: row.questionId! }
      : row.kind === "response" ? { kind: "response", responseId: row.responseId! }
        : { kind: row.kind, userId: row.subjectUserId! }), row.id);
  }
  return found;
}

/**
 * 本人の現在のプロフィール版と公開状態。公開状態と現在版は同じ問い合わせで読み、組み合わせの食い違いを避ける。
 * 現在版が公開版なのは `profileState` が public のときだけ。
 */
async function currentProfile(tx: CaseWriter, userId: string) {
  const [row] = await tx.select({
    profileState: communityUsers.profileState,
    baseRole: communityUsers.baseRole,
    isGraduating: communityUsers.isGraduating,
    userVersion: communityUsers.version,
    revisionNo: profileRevisions.revisionNo,
    displayName: profileRevisions.displayName,
    department: profileRevisions.department,
    entryYear: profileRevisions.entryYear,
    graduationYear: profileRevisions.graduationYear,
    optionalValues: profileRevisions.optionalValues,
    fieldVisibility: profileRevisions.fieldVisibility,
  }).from(communityUsers)
    .innerJoin(profiles, eq(profiles.userId, communityUsers.userId))
    .innerJoin(profileRevisions, eq(profileRevisions.id, profiles.currentRevisionId))
    .where(eq(communityUsers.userId, userId));
  return row ?? null;
}

/** API設計書 §13 EvidenceSnapshot の content。保全する公開内容がなければ（非表示中のプロフィール、強制非表示・削除済みの投稿）null。 */
async function snapshotOf(tx: CaseWriter, target: EvidenceTarget): Promise<Snapshot | null> {
  const missing = () => new Error(`通報対象 ${target.kind} が見つかりません。`);
  switch (target.kind) {
    case "question": {
      const [row] = await tx.select({
        version: qaQuestions.version, title: qaQuestions.title,
        bodyMarkdown: qaQuestions.bodyMarkdown, authorLabel: qaQuestions.authorLabel,
        forcedHiddenAt: qaQuestions.forcedHiddenAt, deletedAt: qaQuestions.deletedAt,
      }).from(qaQuestions).where(eq(qaQuestions.id, target.questionId));
      if (!row) throw missing();
      const { version, forcedHiddenAt, deletedAt, ...content } = row;
      // 強制非表示中・削除済みの内容は公開されていないため保存しない。
      if (forcedHiddenAt || deletedAt) return null;
      return { sourceRevision: version, content };
    }
    case "response": {
      const [row] = await tx.select({
        version: qaResponses.version, bodyMarkdown: qaResponses.bodyMarkdown, authorLabel: qaResponses.authorLabel,
        kind: qaResponses.kind, questionId: qaResponses.questionId, parentResponseId: qaResponses.parentResponseId,
        forcedHiddenAt: qaResponses.forcedHiddenAt, deletedAt: qaResponses.deletedAt,
      }).from(qaResponses).where(eq(qaResponses.id, target.responseId));
      if (!row) throw missing();
      // 親投稿の本文は含めない（削除済みの親の本文を残存回答の証拠へ追加しない。API設計書 §13）。
      const { version, forcedHiddenAt, deletedAt, ...content } = row;
      if (forcedHiddenAt || deletedAt) return null;
      return { sourceRevision: version, content };
    }
    case "profile": {
      const profile = await currentProfile(tx, target.userId);
      if (!profile) throw missing();
      // 非表示中の現在版は未承認の版の可能性があるため保存しない。
      if (profile.profileState !== "public") return null;
      return {
        sourceRevision: profile.revisionNo,
        content: {
          userId: target.userId,
          baseRole: profile.baseRole,
          isGraduating: profile.isGraduating,
          fields: {
            displayName: profile.displayName,
            department: profile.department,
            entryYear: profile.entryYear,
            graduationYear: profile.graduationYear,
            // 本人以外が見られる項目（members）だけ。本人のみの項目はキーごと省略する。
            optionalFields: projectOptionalProfileFields(profile, "member"),
          },
        },
      };
    }
    case "account": {
      const profile = await currentProfile(tx, target.userId);
      if (!profile) throw missing();
      return {
        sourceRevision: profile.userVersion,
        content: {
          userId: target.userId,
          // 非表示中は公開している表示名がないため null にし、未承認の版の表示名を保存しない。
          displayName: profile.profileState === "public" ? profile.displayName : null,
          baseRole: profile.baseRole,
        },
      };
    }
  }
}

export type PreservedEvidence = { target: EvidenceTarget; evidenceId: string; caseIds: string[] };

const openStatuses = ["unhandled", "in_progress"] as const;

/**
 * 通報対象の現在の公開内容を証拠として保全し、未終了案件に関連付ける。証拠を保存・関連付けた対象ごとの結果を返す。
 * 未終了案件がない対象と、保全する公開内容がない対象（非表示中のプロフィール、強制非表示・削除済みの投稿）は何もしない。
 *
 * - 対象の `report_targets` は1つの問い合わせでまとめて取得する。通報されていない対象が多くても往復は増えない。
 * - 指定したすべての対象の未終了案件を、1つの問い合わせでID昇順に `FOR UPDATE` でロックしてから関連付ける。
 *   同じ利用者のプロフィールとアカウントなど、複数の対象を保全する場合は1回の呼び出しにまとめる。対象ごとに呼ぶと、
 *   案件のロックがID順にならず、同じ案件をID順にロックする引継ぎ処理とデッドロックする。
 * - ロック順は本体 → 申請 → 案件（共通認可条件表 §5）のため、本体・申請のロックを取得した後に呼ぶ。
 *   更新・削除の前の内容を残す場合は、ロック後・更新前に呼ぶ。
 * - 証拠の取得時刻は、案件のロック後のDB時刻（`lockedCaseTime`）にする。
 * - 同じ対象で内容が同じ証拠が既にあれば、版番号が変わっていても新しく保存せず、その証拠を関連付ける。再送・同じ内容での
 *   再実行や、証拠に含めない項目（質問の解決状態など）だけの変更で重複しない。
 */
export async function preserveEvidence(
  tx: CaseWriter,
  input: { targets: readonly EvidenceTarget[] },
): Promise<PreservedEvidence[]> {
  const found = await findReportTargets(tx, input.targets);
  const resolved: Array<{ target: EvidenceTarget; reportTargetId: string }> = [];
  const seen = new Set<string>();
  for (const target of input.targets) {
    const key = targetKey(target);
    const reportTargetId = found.get(key);
    // 同じ対象が重複して指定されても1回だけ処理する。
    if (reportTargetId && !seen.has(key)) resolved.push({ target, reportTargetId });
    seen.add(key);
  }
  if (resolved.length === 0) return [];
  const openCases = await tx.select({ id: reportCases.id, targetId: reportCases.targetId }).from(reportCases)
    .where(and(
      inArray(reportCases.targetId, resolved.map(({ reportTargetId }) => reportTargetId)),
      inArray(reportCases.status, [...openStatuses]),
    ))
    .orderBy(asc(reportCases.id)).for("update");
  if (openCases.length === 0) return [];

  let capturedAt: SQL | null = null;
  const results: PreservedEvidence[] = [];
  for (const { target, reportTargetId } of resolved) {
    const caseIds = openCases.filter(({ targetId }) => targetId === reportTargetId).map(({ id }) => id);
    if (caseIds.length === 0) continue;
    const snapshot = await snapshotOf(tx, target);
    if (!snapshot) continue;

    const [existing] = await tx.select({ id: evidenceSnapshots.id }).from(evidenceSnapshots).where(and(
      eq(evidenceSnapshots.targetId, reportTargetId),
      sql`${evidenceSnapshots.snapshot} = ${JSON.stringify(snapshot.content)}::jsonb`,
    )).orderBy(desc(evidenceSnapshots.capturedAt), desc(evidenceSnapshots.id)).limit(1);
    let evidenceId = existing?.id;
    if (!evidenceId) {
      // 同じ呼び出しで保存する証拠は、同じ取得時刻にする。
      capturedAt ??= await lockedCaseTime(tx);
      [{ id: evidenceId }] = await tx.insert(evidenceSnapshots).values({
        targetId: reportTargetId, sourceRevision: snapshot.sourceRevision, snapshot: snapshot.content, capturedAt,
      }).returning({ id: evidenceSnapshots.id });
    }

    await tx.insert(reportCaseEvidence).values(caseIds.map((caseId) => ({ caseId, evidenceId })))
      .onConflictDoNothing({ target: [reportCaseEvidence.caseId, reportCaseEvidence.evidenceId] });
    results.push({ target, evidenceId, caseIds });
  }
  return results;
}
