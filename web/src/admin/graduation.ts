import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { recordAuditLogs } from "@/api/audit-log";
import { containing, fourDigitYear, searchText } from "@/api/list-filters";
import { assertExpectedVersion } from "@/api/mutation";
import { createCursorCodec, cursorTimestamp, parseListQuery, queryListPage } from "@/api/pagination";
import { confirmed, expectedVersion, userId as userIdSchema, uuid } from "@/api/request";
import { preserveEvidence, type CaseWriter } from "@/api/report-evidence";
import { ApiError } from "@/api/response";
import type { AccessReader, Viewer } from "@/auth/access";
import { communityUsers, graduationChanges, profileRevisions, profiles } from "@/db/schema";
import { alias } from "drizzle-orm/pg-core";
import { graduationBatchLimit } from "./graduation-limits";

/**
 * 卒業区分の一括変更・指定修正・履歴（API-GR-01〜04、AD-13）。Issue #8 ⑥。学校管理者だけが利用する。
 *
 * - 一括変更は、卒業予定の在校生を卒業生にする。修正は、在校生・卒業生の区分と卒業予定状態を指定する（API-DEC-04）。
 * - 変えるのは `community_users` の所属区分・卒業予定・版番号だけ。利用者ID・投稿・プロフィール版・管理権限・停止・公開状態は
 *   変えない（PR-04）。
 * - 変更前の公開内容の証拠保全、変更履歴、監査ログを同じトランザクションで確定し、途中の失敗では何も変えない。
 * - 非表示中の利用者も対象にできる。公開版がないため、表示名（現在版は審査前の内容の可能性がある）を返さず、検索・並び順にも
 *   使わない（API設計書 §3）。
 */

type BaseRole = "student" | "alumni";

/** API設計書 §14 GraduationCandidate。非表示中は公開表示名がないため `displayName` は null。 */
export type GraduationCandidate = {
  userId: string;
  displayName: string | null;
  baseRole: BaseRole;
  isGraduating: boolean;
  department: string | null;
  entryYear: number | null;
  graduationYear: number | null;
  version: number;
};

/** 発行完了・学校確認済みの利用者。発行準備中の利用者は存在しないものとして扱う。 */
function provisioned(): SQL {
  return and(eq(communityUsers.provisioningStatus, "ready"), eq(communityUsers.eligibilityStatus, "verified"))!;
}

/** 公開中の表示名。非表示中は null。 */
const publicName = sql<string | null>`CASE WHEN ${communityUsers.profileState} = 'public' THEN ${profileRevisions.displayName} END`;

const candidateColumns = {
  userId: communityUsers.userId,
  displayName: publicName,
  baseRole: communityUsers.baseRole,
  isGraduating: communityUsers.isGraduating,
  department: profileRevisions.department,
  entryYear: profileRevisions.entryYear,
  graduationYear: profileRevisions.graduationYear,
  version: communityUsers.version,
};

const currentRevision = and(
  eq(profileRevisions.id, profiles.currentRevisionId), eq(profileRevisions.userId, profiles.userId),
);

function candidateSource(reader: AccessReader) {
  return reader.select(candidateColumns).from(communityUsers)
    .innerJoin(profiles, eq(profiles.userId, communityUsers.userId))
    .innerJoin(profileRevisions, currentRevision);
}

type CandidateRow = Awaited<ReturnType<ReturnType<typeof candidateSource>["execute"]>>[number];

function toCandidate(row: CandidateRow): GraduationCandidate {
  // 取得条件で在校生・卒業生に限定している。
  if (row.baseRole === "staff") throw new Error("卒業区分の対象に学校職員が含まれています。");
  return { ...row, baseRole: row.baseRole };
}

/** 一括変更の対象にできる利用者。 */
function graduatingStudent(): SQL {
  return and(eq(communityUsers.baseRole, "student"), eq(communityUsers.isGraduating, true))!;
}

/** 修正の対象にできる利用者。 */
function correctable(): SQL {
  return inArray(communityUsers.baseRole, ["student", "alumni"]);
}

/** 候補の検索条件（API設計書 §3・§14）。 */
export const graduationCandidateFilters = {
  mode: z.enum(["graduate", "correction"]).default("graduate"),
  q: searchText.optional(),
  department: searchText.optional(),
  graduationYear: fourDigitYear.optional(),
};

export type GraduationCandidateQuery = ReturnType<typeof parseGraduationCandidateQuery>;

export function parseGraduationCandidateQuery(url: URL) {
  return parseListQuery(url, graduationCandidateFilters);
}

const candidatePosition = z.tuple([z.string().nullable(), z.string()]);

/** 卒業区分の変更候補（API-GR-01）。公開表示名の昇順・利用者IDの昇順。公開表示名のない（非表示中の）利用者は最後に並べる。 */
export async function listGraduationCandidates(reader: AccessReader, viewer: Viewer, query: GraduationCandidateQuery) {
  const { mode, q, department, graduationYear, limit, cursor } = query;
  const codec = createCursorCodec({
    actorId: viewer.userId,
    list: "graduation-candidates",
    filters: { mode, q, department, graduationYear },
    sort: "displayName:asc,userId:asc",
  }, candidatePosition);
  const last = codec.decode(cursor);
  const after = last === null ? undefined : last[0] === null
    ? and(sql`${publicName} IS NULL`, sql`${communityUsers.userId} > ${last[1]}`)
    : or(sql`(${publicName}, ${communityUsers.userId}) > (${last[0]}, ${last[1]})`, sql`${publicName} IS NULL`);
  const filters = [
    // 公開版・公開項目だけに一致させる。審査前の表示名に一致したかを、結果・件数に反映しない。
    q === undefined ? undefined : or(sql`${publicName} ILIKE ${containing(q)}`, ilike(communityUsers.userId, containing(q))),
    department === undefined ? undefined : eq(profileRevisions.department, department),
    graduationYear === undefined ? undefined : eq(profileRevisions.graduationYear, graduationYear),
  ].filter((condition): condition is SQL => condition !== undefined);

  return queryListPage({
    authorized: and(provisioned(), mode === "graduate" ? graduatingStudent() : correctable())!,
    filters: filters.length ? and(...filters) : undefined,
    after,
    limit,
    rows: (where, take) => candidateSource(reader).where(where)
      .orderBy(sql`${publicName} ASC NULLS LAST`, asc(communityUsers.userId)).limit(take),
    count: async (where) => {
      const [{ total }] = await reader.select({ total: count() }).from(communityUsers)
        .innerJoin(profiles, eq(profiles.userId, communityUsers.userId))
        .innerJoin(profileRevisions, currentRevision)
        .where(where);
      return total;
    },
    cursorFor: (row) => codec.encode([row.displayName, row.userId]),
    toItem: toCandidate,
  });
}

/** 修正の対象にする利用者1人（AD-13 の修正画面）。対象外・存在しない利用者は404。 */
export async function loadCorrectionCandidate(reader: AccessReader, userId: string): Promise<GraduationCandidate> {
  const [row] = await candidateSource(reader).where(and(eq(communityUsers.userId, userId), provisioned(), correctable()));
  if (!row) throw new ApiError("NOT_FOUND");
  return toCandidate(row);
}

/** API設計書 §14 GraduationBatch。 */
export const graduationBatchSchema = z.strictObject({
  targets: z.array(z.strictObject({ userId: userIdSchema, expectedVersion })).min(1).max(graduationBatchLimit)
    .refine((targets) => new Set(targets.map(({ userId }) => userId)).size === targets.length),
  confirmed,
});

/** API設計書 §14 GraduationCorrection。卒業生の卒業予定は422。 */
export const graduationCorrectionSchema = z.strictObject({
  userId: userIdSchema,
  expectedVersion,
  baseRole: z.enum(["student", "alumni"]),
  isGraduating: z.boolean(),
  confirmed,
});

export type GraduationCorrection = z.infer<typeof graduationCorrectionSchema>;

/** 卒業生に卒業予定を指定した入力を 422 にする。 */
export function requireCorrectableState(correction: GraduationCorrection): void {
  if (correction.baseRole === "alumni" && correction.isGraduating) {
    throw new ApiError("VALIDATION_FAILED", {
      fields: [{ path: "isGraduating", code: "alumni_graduating", message: "卒業生は卒業予定にできません。" }],
    });
  }
}

type LockedContext = { tx: CaseWriter; now: Date; requireLockedUsers: (...ids: string[]) => void };
type GraduationState = { baseRole: BaseRole; isGraduating: boolean };
type LockedUser = { userId: string; baseRole: "student" | "alumni" | "staff"; isGraduating: boolean; version: number };

/** 対象者のロック後の状態。ロックしていない対象者は含めてやり直し、存在しない・発行準備中の対象者は404。 */
async function lockedTargets(context: LockedContext, userIds: readonly string[]): Promise<Map<string, LockedUser>> {
  context.requireLockedUsers(...userIds);
  const rows = await context.tx.select({
    userId: communityUsers.userId, baseRole: communityUsers.baseRole,
    isGraduating: communityUsers.isGraduating, version: communityUsers.version,
  }).from(communityUsers).where(and(inArray(communityUsers.userId, [...userIds]), provisioned()));
  if (rows.length !== userIds.length) throw new ApiError("NOT_FOUND");
  return new Map(rows.map((row) => [row.userId, row]));
}

/** 確認済みの対象者の区分を変え、証拠保全・変更履歴・監査ログを記録する。戻り値は変更のバッチID。 */
async function commitChange(context: LockedContext, input: {
  actorId: string; users: ReadonlyArray<LockedUser & GraduationState>; after: GraduationState;
  changeKind: "graduation" | "correction";
}): Promise<string> {
  const { tx, now } = context;
  const { actorId, users, after, changeKind } = input;
  const userIds = users.map(({ userId }) => userId);
  // 変更前の公開内容（所属区分を含む）を、プロフィールとアカウントの通報証拠として保全する（1回の呼び出しで案件をID順にロック）。
  await preserveEvidence(tx, {
    targets: userIds.flatMap((userId) => [{ kind: "profile" as const, userId }, { kind: "account" as const, userId }]),
  });

  const updated = await tx.update(communityUsers).set({ ...after, version: sql`${communityUsers.version} + 1` })
    .where(inArray(communityUsers.userId, userIds)).returning({ userId: communityUsers.userId });
  if (updated.length !== users.length) throw new ApiError("STATE_CONFLICT");

  const batchId = randomUUID();
  await tx.insert(graduationChanges).values(users.map((user) => ({
    batchId, userId: user.userId, actorId, changeKind,
    beforeRole: user.baseRole, afterRole: after.baseRole,
    beforeGraduating: user.isGraduating, afterGraduating: after.isGraduating, createdAt: now,
  })));
  await recordAuditLogs(tx, users.map((user) => ({
    action: changeKind === "graduation" ? "graduation.graduated" as const : "graduation.corrected" as const,
    actorId, targetId: user.userId,
    before: { baseRole: user.baseRole, isGraduating: user.isGraduating, version: user.version, batchId },
    after: { ...after, version: user.version + 1, batchId },
    at: now,
  })));
  return batchId;
}

/**
 * 卒業予定の在校生を卒業生へ一括変更する（API-GR-02）。`commitMutation` の `execute` の中で呼び、`resolveUserIds` に
 * 全対象者を含める。1人でも版番号・資格が違えば409とし、誰も変更しない。
 */
export async function applyGraduation(
  context: LockedContext, input: { actorId: string; targets: z.infer<typeof graduationBatchSchema>["targets"] },
): Promise<{ batchId: string; affectedCount: number }> {
  const found = await lockedTargets(context, input.targets.map(({ userId }) => userId));
  const users = input.targets.map(({ userId, expectedVersion: version }) => {
    const user = found.get(userId)!;
    assertExpectedVersion(user.version, version);
    if (user.baseRole !== "student" || !user.isGraduating) throw new ApiError("STATE_CONFLICT");
    return { ...user, baseRole: user.baseRole };
  });
  const batchId = await commitChange(context, {
    actorId: input.actorId, users, after: { baseRole: "alumni", isGraduating: false }, changeKind: "graduation",
  });
  return { batchId, affectedCount: users.length };
}

/**
 * 卒業区分の誤変更を、指定した区分へ修正する（API-GR-03）。対象は現在の在校生・卒業生だけ（学校職員は409）。
 * 現在と同じ区分への修正は、変更のない履歴を作らないよう409にする。
 */
export async function correctGraduation(
  context: LockedContext, input: { actorId: string; correction: GraduationCorrection },
): Promise<{ batchId: string }> {
  const { userId, expectedVersion: version, baseRole, isGraduating } = input.correction;
  const user = (await lockedTargets(context, [userId])).get(userId)!;
  assertExpectedVersion(user.version, version);
  if (user.baseRole === "staff") throw new ApiError("STATE_CONFLICT");
  if (user.baseRole === baseRole && user.isGraduating === isGraduating) throw new ApiError("STATE_CONFLICT");
  const batchId = await commitChange(context, {
    actorId: input.actorId, users: [{ ...user, baseRole: user.baseRole }], after: { baseRole, isGraduating },
    changeKind: "correction",
  });
  return { batchId };
}

/** API設計書 §14 GraduationChange。 */
export type GraduationChange = {
  id: string;
  batchId: string;
  userId: string;
  actor: { userId: string; displayName: string };
  changeKind: "graduation" | "correction";
  before: GraduationState;
  after: GraduationState;
  createdAt: string;
};

/** 画面の履歴に表示する変更。API では `change` だけを返す。`displayName` は対象者の公開表示名（非表示中は null）。 */
export type GraduationChangeListItem = { change: GraduationChange; displayName: string | null };

export type GraduationChangeQuery = ReturnType<typeof parseGraduationChangeQuery>;

export function parseGraduationChangeQuery(url: URL) {
  return parseListQuery(url, { userId: userIdSchema.optional(), batchId: uuid.optional() });
}

const changePosition = z.tuple([z.string(), z.string()]);

/** 非表示中の実行者の表示名の代わり。学校管理者は非表示の対象外のため、通常は使わない。 */
const hiddenActorName = "非表示の利用者";

/** 卒業区分の変更履歴（API-GR-04）。変更日時の降順・IDの降順。利用者・バッチで絞り込める。 */
export async function listGraduationChanges(reader: AccessReader, viewer: Viewer, query: GraduationChangeQuery) {
  const { userId, batchId, limit, cursor } = query;
  const codec = createCursorCodec({
    actorId: viewer.userId,
    list: "graduation-changes",
    filters: { userId, batchId },
    sort: "createdAt:desc,id:desc",
  }, changePosition);
  const last = codec.decode(cursor);
  const filters = [
    userId === undefined ? undefined : eq(graduationChanges.userId, userId),
    batchId === undefined ? undefined : eq(graduationChanges.batchId, batchId),
  ].filter((condition): condition is SQL => condition !== undefined);
  const actorUsers = alias(communityUsers, "actor_users");
  const actorProfiles = alias(profiles, "actor_profiles");
  const actorRevisions = alias(profileRevisions, "actor_revisions");

  return queryListPage({
    authorized: sql`true`,
    filters: filters.length ? and(...filters) : undefined,
    after: last
      ? sql`(${graduationChanges.createdAt}, ${graduationChanges.id}) < (${last[0]}::timestamptz, ${last[1]}::uuid)`
      : undefined,
    limit,
    rows: (where, take) => reader.select({
      id: graduationChanges.id,
      batchId: graduationChanges.batchId,
      userId: graduationChanges.userId,
      actorId: graduationChanges.actorId,
      actorName: actorRevisions.displayName,
      actorState: actorUsers.profileState,
      changeKind: graduationChanges.changeKind,
      beforeRole: graduationChanges.beforeRole,
      afterRole: graduationChanges.afterRole,
      beforeGraduating: graduationChanges.beforeGraduating,
      afterGraduating: graduationChanges.afterGraduating,
      createdAt: graduationChanges.createdAt,
      cursorAt: cursorTimestamp(graduationChanges.createdAt),
      displayName: publicName,
    }).from(graduationChanges)
      .innerJoin(communityUsers, eq(communityUsers.userId, graduationChanges.userId))
      .innerJoin(profiles, eq(profiles.userId, graduationChanges.userId))
      .innerJoin(profileRevisions, currentRevision)
      .innerJoin(actorUsers, eq(actorUsers.userId, graduationChanges.actorId))
      .innerJoin(actorProfiles, eq(actorProfiles.userId, graduationChanges.actorId))
      .innerJoin(actorRevisions, eq(actorRevisions.id, actorProfiles.currentRevisionId))
      .where(where).orderBy(desc(graduationChanges.createdAt), desc(graduationChanges.id)).limit(take),
    count: async (where) => {
      const [{ total }] = await reader.select({ total: count() }).from(graduationChanges).where(where);
      return total;
    },
    cursorFor: (row) => codec.encode([row.cursorAt, row.id]),
    toItem: (row): GraduationChangeListItem => ({
      change: {
        id: row.id,
        batchId: row.batchId,
        userId: row.userId,
        actor: { userId: row.actorId, displayName: row.actorState === "public" ? row.actorName : hiddenActorName },
        changeKind: row.changeKind,
        before: { baseRole: row.beforeRole, isGraduating: row.beforeGraduating },
        after: { baseRole: row.afterRole, isGraduating: row.afterGraduating },
        createdAt: row.createdAt.toISOString(),
      },
      displayName: row.displayName,
    }),
  });
}
