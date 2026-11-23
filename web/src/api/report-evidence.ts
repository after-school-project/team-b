import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
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
 * - 証拠に関係する更新・削除の前（#8 のプロフィール保存、#9 の質問・回答等の削除など）：更新する前の内容で呼ぶ
 *
 * 保存する内容は API設計書 §13 の EvidenceSnapshot に従い、公開内容だけにする。本人確認情報、管理権限、
 * 本人のみの任意プロフィール項目は保存しない。対象の行は、呼び出し側が本体としてロックしておく。
 */

/** 業務更新と同じトランザクション。 */
export type CaseWriter = Pick<PgDatabase<PgQueryResultHKT, Record<string, unknown>>, "select" | "insert" | "update">;

/** 通報対象。プロフィール・アカウントは利用者ID、質問・回答等はそのID。 */
export type EvidenceTarget =
  | { kind: "question"; questionId: string }
  | { kind: "response"; responseId: string }
  | { kind: "profile"; userId: string }
  | { kind: "account"; userId: string };

type Snapshot = { sourceRevision: number; content: Record<string, unknown> };

function targetCondition(target: EvidenceTarget): SQL {
  switch (target.kind) {
    case "question": return and(eq(reportTargets.kind, "question"), eq(reportTargets.questionId, target.questionId))!;
    case "response": return and(eq(reportTargets.kind, "response"), eq(reportTargets.responseId, target.responseId))!;
    case "profile":
    case "account":
      return and(eq(reportTargets.kind, target.kind), eq(reportTargets.subjectUserId, target.userId))!;
  }
}

/** 現在の公開表示名などを持つ、本人の現在のプロフィール版。 */
async function currentProfile(tx: CaseWriter, userId: string) {
  const [row] = await tx.select({
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

/** API設計書 §13 EvidenceSnapshot の content。対象がなければ null。 */
async function snapshotOf(tx: CaseWriter, target: EvidenceTarget): Promise<Snapshot | null> {
  switch (target.kind) {
    case "question": {
      const [row] = await tx.select({
        version: qaQuestions.version, title: qaQuestions.title,
        bodyMarkdown: qaQuestions.bodyMarkdown, authorLabel: qaQuestions.authorLabel,
      }).from(qaQuestions).where(eq(qaQuestions.id, target.questionId));
      if (!row) return null;
      const { version, ...content } = row;
      return { sourceRevision: version, content };
    }
    case "response": {
      const [row] = await tx.select({
        version: qaResponses.version, bodyMarkdown: qaResponses.bodyMarkdown, authorLabel: qaResponses.authorLabel,
        kind: qaResponses.kind, questionId: qaResponses.questionId, parentResponseId: qaResponses.parentResponseId,
      }).from(qaResponses).where(eq(qaResponses.id, target.responseId));
      if (!row) return null;
      // 親投稿の本文は含めない（削除済みの親の本文を残存回答の証拠へ追加しない。API設計書 §13）。
      const { version, ...content } = row;
      return { sourceRevision: version, content };
    }
    case "profile": {
      const profile = await currentProfile(tx, target.userId);
      if (!profile) return null;
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
      if (!profile) return null;
      return {
        sourceRevision: profile.userVersion,
        content: { userId: target.userId, displayName: profile.displayName, baseRole: profile.baseRole },
      };
    }
  }
}

export type PreservedEvidence = { evidenceId: string; caseIds: string[] };

/**
 * 通報対象の現在の公開内容を証拠として保全し、未終了案件に関連付ける。未終了案件がなければ何もせず null を返す。
 *
 * - 未終了案件の行を `FOR UPDATE` でロックしてから関連付ける。ロック順は本体 → 申請 → 案件（共通認可条件表 §5）のため、
 *   本体・申請のロックを取得した後に呼ぶ。更新・削除の前の内容を残す場合は、ロック後・更新前に呼ぶ。
 * - 同じ対象で内容が同じ証拠が既にあれば、新しく保存せずにその証拠を関連付ける。再送・同じ内容での再実行で重複しない。
 */
export async function preserveEvidence(
  tx: CaseWriter,
  input: { target: EvidenceTarget; at: Date },
): Promise<PreservedEvidence | null> {
  const [reportTarget] = await tx.select({ id: reportTargets.id }).from(reportTargets)
    .where(targetCondition(input.target));
  if (!reportTarget) return null;
  const openCases = await tx.select({ id: reportCases.id }).from(reportCases)
    .where(and(eq(reportCases.targetId, reportTarget.id), inArray(reportCases.status, ["unhandled", "in_progress"])))
    .orderBy(asc(reportCases.id)).for("update");
  if (openCases.length === 0) return null;

  const snapshot = await snapshotOf(tx, input.target);
  if (!snapshot) throw new Error(`通報対象 ${input.target.kind} が見つかりません。`);

  const [existing] = await tx.select({ id: evidenceSnapshots.id }).from(evidenceSnapshots).where(and(
    eq(evidenceSnapshots.targetId, reportTarget.id),
    eq(evidenceSnapshots.sourceRevision, snapshot.sourceRevision),
    sql`${evidenceSnapshots.snapshot} = ${JSON.stringify(snapshot.content)}::jsonb`,
  )).orderBy(desc(evidenceSnapshots.capturedAt), desc(evidenceSnapshots.id)).limit(1);
  const evidenceId = existing?.id ?? (await tx.insert(evidenceSnapshots).values({
    targetId: reportTarget.id, sourceRevision: snapshot.sourceRevision, snapshot: snapshot.content, capturedAt: input.at,
  }).returning({ id: evidenceSnapshots.id }))[0].id;

  const caseIds = openCases.map(({ id }) => id);
  await tx.insert(reportCaseEvidence).values(caseIds.map((caseId) => ({ caseId, evidenceId })))
    .onConflictDoNothing({ target: [reportCaseEvidence.caseId, reportCaseEvidence.evidenceId] });
  return { evidenceId, caseIds };
}
