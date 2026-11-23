import { and, desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import { assertExpectedVersion } from "@/api/mutation";
import { displayName, expectedVersion, optionalProfileText } from "@/api/request";
import { ApiError } from "@/api/response";
import { preserveEvidence, type CaseWriter } from "@/api/report-evidence";
import type { AccessReader } from "@/auth/access";
import {
  optionalProfileFields, projectOptionalProfileFields, type OptionalProfileField, type OptionalProfileFieldView,
} from "@/auth/visibility";
import { communityUsers, profileReviews, profileRevisions, profiles } from "@/db/schema";
import { optionalFieldLimits } from "./limits";

/**
 * マイプロフィール（GE-02、API-PRO-01・02）。Issue #8 ①②と、⑤のうち非表示中の本人による修正・再公開申請。
 *
 * - 本人が更新できるのは公開表示名・任意項目（値と公開範囲）・検索掲載希望だけ。所属・学科・年度・本人確認情報・
 *   管理権限は受け付けない（未定義の項目は 422）。
 * - 保存ごとに不変のプロフィール版を作り、現在版を切り替える。`profiles.version` で同時更新を検出する。
 * - 非表示中の保存は、再公開申請（pending の審査）の作成または対象版の更新を同じトランザクションで行う。
 * - 公開中の保存では、変更前の公開内容をプロフィールとアカウントの通報証拠として保全する（#47）。
 */

const visibility = z.enum(["members", "self"]);
const optionalFieldPatch = (maxLength: number) => z.strictObject({
  value: optionalProfileText(maxLength).optional(),
  visibility: visibility.optional(),
});

/** API設計書 §6 ProfilePatch。 */
export const profilePatchSchema = z.strictObject({
  expectedVersion,
  displayName: displayName.optional(),
  searchOptIn: z.boolean().optional(),
  optionalFields: z.strictObject({
    bio: optionalFieldPatch(optionalFieldLimits.bio).optional(),
    occupation: optionalFieldPatch(optionalFieldLimits.occupation).optional(),
    interests: optionalFieldPatch(optionalFieldLimits.interests).optional(),
  }).optional(),
});

export type ProfilePatch = z.infer<typeof profilePatchSchema>;

/** 変更する項目が1つもない入力を 422 にする（displayName・searchOptIn・optionalFields のうち1つ以上が必須）。 */
export function requireProfileChanges(patch: ProfilePatch): void {
  const fields: Array<{ path: string; code: string; message: string }> = [];
  if (patch.displayName === undefined && patch.searchOptIn === undefined && patch.optionalFields === undefined) {
    fields.push({ path: "", code: "missing_change", message: "変更する項目を指定してください。" });
  }
  if (patch.optionalFields) {
    const entries = Object.entries(patch.optionalFields).filter(([, field]) => field !== undefined);
    if (entries.length === 0) {
      fields.push({ path: "optionalFields", code: "missing_change", message: "変更する項目を指定してください。" });
    }
    for (const [name, field] of entries) {
      if (field && field.value === undefined && field.visibility === undefined) {
        fields.push({ path: `optionalFields.${name}`, code: "missing_change", message: "変更する項目を指定してください。" });
      }
    }
  }
  if (fields.length) throw new ApiError("VALIDATION_FAILED", { fields });
}

/** API設計書 §5 ProfileReviewSummary。 */
export type ProfileReviewSummary = {
  id: string;
  status: "pending" | "approved" | "rejected";
  submittedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
};

/** API設計書 §5 MyProfile。本人確認情報と管理権限は含めない。 */
export type MyProfile = {
  userId: string;
  version: number;
  profileState: "public" | "hidden";
  baseRole: "student" | "alumni" | "staff";
  isGraduating: boolean;
  searchOptIn: boolean;
  fields: {
    displayName: string;
    department: string | null;
    entryYear: number | null;
    graduationYear: number | null;
    optionalFields: Partial<Record<OptionalProfileField, OptionalProfileFieldView>>;
  };
  review: ProfileReviewSummary | null;
};

/** 本人のマイプロフィール。利用中の利用者には、発行時に作るプロフィールが必ずある。 */
export async function loadMyProfile(reader: AccessReader, userId: string): Promise<MyProfile> {
  const [row] = await reader.select({
    profileState: communityUsers.profileState,
    baseRole: communityUsers.baseRole,
    isGraduating: communityUsers.isGraduating,
    version: profiles.version,
    searchOptIn: profiles.searchOptIn,
    displayName: profileRevisions.displayName,
    department: profileRevisions.department,
    entryYear: profileRevisions.entryYear,
    graduationYear: profileRevisions.graduationYear,
    optionalValues: profileRevisions.optionalValues,
    fieldVisibility: profileRevisions.fieldVisibility,
  }).from(communityUsers)
    .innerJoin(profiles, eq(profiles.userId, communityUsers.userId))
    .innerJoin(profileRevisions, and(
      eq(profileRevisions.id, profiles.currentRevisionId), eq(profileRevisions.userId, profiles.userId),
    ))
    .where(eq(communityUsers.userId, userId));
  if (!row) throw new Error("利用中の利用者のプロフィールが見つかりません。");

  // 最新の再公開申請（審査中、または最後に確定したもの）。審査結果は本人通知とここで確認する。
  const [review] = await reader.select({
    id: profileReviews.id,
    status: profileReviews.status,
    submittedAt: profileReviews.submittedAt,
    decidedAt: profileReviews.decidedAt,
    decisionReason: profileReviews.decisionReason,
    version: profileReviews.version,
  }).from(profileReviews).where(eq(profileReviews.userId, userId))
    .orderBy(desc(profileReviews.submittedAt), desc(profileReviews.id)).limit(1);

  return {
    userId,
    version: row.version,
    profileState: row.profileState,
    baseRole: row.baseRole,
    isGraduating: row.isGraduating,
    searchOptIn: row.searchOptIn,
    fields: {
      displayName: row.displayName,
      department: row.department,
      entryYear: row.entryYear,
      graduationYear: row.graduationYear,
      optionalFields: projectOptionalProfileFields(row, "owner"),
    },
    review: review ? {
      ...review,
      submittedAt: review.submittedAt.toISOString(),
      decidedAt: review.decidedAt?.toISOString() ?? null,
    } : null,
  };
}

/**
 * 本人のプロフィールを保存する。`commitMutation` の `execute` の中で呼び、`targets` で本人の `profiles`（本体）と
 * `profile_reviews`（申請）をロックしておく。戻り値は保存後の版番号と公開状態。
 */
export async function saveMyProfile(
  tx: CaseWriter,
  input: { userId: string; patch: ProfilePatch; now: Date },
): Promise<{ version: number; state: "public" | "hidden" }> {
  const { userId, patch, now } = input;
  const [current] = await tx.select({
    profileState: communityUsers.profileState,
    version: profiles.version,
    searchOptIn: profiles.searchOptIn,
    revision: profileRevisions,
  }).from(communityUsers)
    .innerJoin(profiles, eq(profiles.userId, communityUsers.userId))
    .innerJoin(profileRevisions, and(
      eq(profileRevisions.id, profiles.currentRevisionId), eq(profileRevisions.userId, profiles.userId),
    ))
    .where(eq(communityUsers.userId, userId));
  if (!current) throw new ApiError("NOT_FOUND");
  assertExpectedVersion(current.version, patch.expectedVersion);

  // 公開中の内容は、変更する前にプロフィールとアカウントの通報証拠として保全する（1回の呼び出しで案件をID順にロック）。
  if (current.profileState === "public") {
    await preserveEvidence(tx, { targets: [{ kind: "profile", userId }, { kind: "account", userId }] });
  }

  const optionalValues: Partial<Record<OptionalProfileField, string>> = {};
  const fieldVisibility: Partial<Record<OptionalProfileField, "members" | "self">> = {};
  for (const field of optionalProfileFields) {
    const value = current.revision.optionalValues[field];
    const shared = current.revision.fieldVisibility[field];
    if (value !== undefined) optionalValues[field] = value;
    if (shared !== undefined) fieldVisibility[field] = shared;
    const change = patch.optionalFields?.[field];
    if (change?.value !== undefined) {
      // 空文字列は値の消去（API設計書 §6）。
      if (change.value === "") delete optionalValues[field];
      else optionalValues[field] = change.value;
    }
    if (change?.visibility !== undefined) fieldVisibility[field] = change.visibility;
  }

  const [{ latest }] = await tx.select({ latest: max(profileRevisions.revisionNo) }).from(profileRevisions)
    .where(eq(profileRevisions.userId, userId));
  // 所属・学科・年度は学校側の管理項目のため、現在版の値を引き継ぐ。
  const [revision] = await tx.insert(profileRevisions).values({
    userId,
    revisionNo: (latest ?? 0) + 1,
    displayName: patch.displayName ?? current.revision.displayName,
    department: current.revision.department,
    entryYear: current.revision.entryYear,
    graduationYear: current.revision.graduationYear,
    optionalValues,
    fieldVisibility,
    createdAt: now,
  }).returning({ id: profileRevisions.id });

  const version = current.version + 1;
  await tx.update(profiles).set({
    currentRevisionId: revision.id, searchOptIn: patch.searchOptIn ?? current.searchOptIn, version,
  }).where(eq(profiles.userId, userId));

  if (current.profileState === "hidden") {
    // 非表示中の保存は再公開申請。審査中なら対象版を差し替えて版番号を上げ、なければ新しく申請する。
    const [pending] = await tx.select({ id: profileReviews.id, version: profileReviews.version }).from(profileReviews)
      .where(and(eq(profileReviews.userId, userId), eq(profileReviews.status, "pending")));
    if (pending) {
      await tx.update(profileReviews).set({ revisionId: revision.id, version: pending.version + 1 })
        .where(eq(profileReviews.id, pending.id));
    } else {
      await tx.insert(profileReviews).values({ userId, revisionId: revision.id, submittedAt: now });
    }
  }
  return { version, state: current.profileState };
}
