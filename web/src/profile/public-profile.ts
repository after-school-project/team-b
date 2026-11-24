import { and, asc, count, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { createCursorCodec, parseListQuery, queryListPage } from "@/api/pagination";
import { ApiError } from "@/api/response";
import type { AccessReader, Viewer } from "@/auth/access";
import {
  optionalProfileFields, projectOptionalProfileFields, publicProfileState,
  type OptionalProfileField, type OptionalProfileFieldView,
} from "@/auth/visibility";
import { communityUsers, profileRevisions, profiles } from "@/db/schema";

/**
 * 他の利用者の公開プロフィール（GE-03、API-PRO-03）と卒業生検索（GE-04、API-PRO-04）。Issue #8 ③④。
 *
 * - 返すのは公開中のプロフィールの、本人以外が見られる項目（`members`）だけ。本人のみ（`self`）の任意項目はキーごと省略し、
 *   本人確認情報・管理権限は返さない（共通認可条件表 §2）。非表示中のプロフィールは状態案内だけを返す。
 * - 卒業生検索は、掲載希望あり・公開中・発行完了・学校確認済みの、卒業生または卒業予定の在校生だけを対象にする
 *   （DB・ER設計書 §3）。本人のみの項目は、検索条件・結果・件数・カーソルのどれにも使わない。
 */

/** API設計書 §5 ProfileFields（本人以外向け）。 */
export type PublicProfileFields = {
  displayName: string;
  department: string | null;
  entryYear: number | null;
  graduationYear: number | null;
  optionalFields: Partial<Record<OptionalProfileField, OptionalProfileFieldView>>;
};

/** API設計書 §5 PublicProfile。 */
export type PublicProfile = {
  userId: string;
  state: "public";
  baseRole: "student" | "alumni" | "staff";
  isGraduating: boolean;
  fields: PublicProfileFields;
  capabilities: { canReport: boolean };
};

/** API設計書 §5 HiddenProfile。氏名・所属・任意項目などのプロフィール情報を返さない。 */
export type HiddenProfile = { userId: string; state: "hidden" };

const profileColumns = {
  userId: communityUsers.userId,
  profileState: communityUsers.profileState,
  baseRole: communityUsers.baseRole,
  isGraduating: communityUsers.isGraduating,
  schoolManager: communityUsers.schoolManager,
  displayName: profileRevisions.displayName,
  department: profileRevisions.department,
  entryYear: profileRevisions.entryYear,
  graduationYear: profileRevisions.graduationYear,
  optionalValues: profileRevisions.optionalValues,
  fieldVisibility: profileRevisions.fieldVisibility,
};

/** 利用中（発行完了・学校確認済み）の利用者。発行準備中の利用者は存在しないものとして扱う。 */
function provisionedUser(): SQL {
  return and(eq(communityUsers.provisioningStatus, "ready"), eq(communityUsers.eligibilityStatus, "verified"))!;
}

function profileSource(reader: AccessReader) {
  return reader.select(profileColumns).from(communityUsers)
    .innerJoin(profiles, eq(profiles.userId, communityUsers.userId))
    .innerJoin(profileRevisions, and(
      eq(profileRevisions.id, profiles.currentRevisionId), eq(profileRevisions.userId, profiles.userId),
    ));
}

type ProfileRow = Awaited<ReturnType<ReturnType<typeof profileSource>["execute"]>>[number];

/**
 * 通報の入口を出せるか（MD-01）。本人と学校管理者は通報の対象外（共通認可条件表 §4）。
 * 通報の受付そのものの判定は #15 で行う。
 */
function canReport(viewer: Viewer, row: Pick<ProfileRow, "userId" | "schoolManager">): boolean {
  return viewer.userId !== row.userId && !row.schoolManager;
}

function toPublicProfile(viewer: Viewer, row: ProfileRow): PublicProfile {
  return {
    userId: row.userId,
    state: "public",
    baseRole: row.baseRole,
    isGraduating: row.isGraduating,
    fields: {
      displayName: row.displayName,
      department: row.department,
      entryYear: row.entryYear,
      graduationYear: row.graduationYear,
      // 本人を含め、他人向けの表示では公開を許可した項目だけを返す。
      optionalFields: projectOptionalProfileFields(row, "member"),
    },
    capabilities: { canReport: canReport(viewer, row) },
  };
}

/**
 * 利用者の公開プロフィール（API-PRO-03）。利用中の利用者がいなければ 404。
 * 非表示中は状態案内だけを返し、表示名・所属・任意項目を含めない。
 */
export async function loadUserProfile(
  reader: AccessReader, viewer: Viewer, userId: string,
): Promise<PublicProfile | HiddenProfile> {
  const [row] = await profileSource(reader).where(and(eq(communityUsers.userId, userId), provisionedUser()));
  if (!row) throw new ApiError("NOT_FOUND");
  if (row.profileState !== "public") return { userId: row.userId, state: "hidden" };
  return toPublicProfile(viewer, row);
}

/** 検索に載せられる利用者（DB・ER設計書 §3）。件数・各ページ・カーソルに同じ条件を使う。 */
export function listedInAlumniSearch(): SQL {
  return and(
    provisionedUser(),
    publicProfileState(),
    eq(profiles.searchOptIn, true),
    or(
      eq(communityUsers.baseRole, "alumni"),
      and(eq(communityUsers.baseRole, "student"), eq(communityUsers.isGraduating, true)),
    ),
  )!;
}

const searchText = z.string().transform((value) => value.trim())
  .refine((value) => value.length > 0 && [...value].length <= 100 && value.isWellFormed() && !value.includes("\0"));
const fourDigitYear = z.string().regex(/^\d{4}$/).transform(Number);

/** 卒業生検索のクエリー（API設計書 §3）。q は前後空白を除いた1〜100文字、学科は100文字以内、年度は4桁の整数。 */
export const alumniFilters = {
  q: searchText.optional(),
  department: searchText.optional(),
  entryYear: fourDigitYear.optional(),
  graduationYear: fourDigitYear.optional(),
};

export type AlumniQuery = ReturnType<typeof parseAlumniQuery>;

/** URLのクエリーを検証する。未定義の項目・形式の誤りは 400 BAD_REQUEST。 */
export function parseAlumniQuery(url: URL) {
  return parseListQuery(url, alumniFilters);
}

/** LIKE の特殊文字をそのままの文字として扱う（PostgreSQL の既定のエスケープ文字は `\`）。 */
function containing(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * キーワードの条件。公開表示名・学科と、公開範囲が `members` の任意項目だけに部分一致させる。
 * 本人のみの項目に一致しても、結果・件数に反映しない（API設計書 §3）。
 */
function keywordCondition(q: string): SQL {
  const pattern = containing(q);
  return or(
    ilike(profileRevisions.displayName, pattern),
    ilike(profileRevisions.department, pattern),
    ...optionalProfileFields.map((field) => and(
      sql`${profileRevisions.fieldVisibility} ->> ${field} = 'members'`,
      sql`${profileRevisions.optionalValues} ->> ${field} ILIKE ${pattern}`,
    )!),
  )!;
}

const cursorPosition = z.tuple([z.string(), z.string()]);

/**
 * 卒業生検索（API-PRO-04）。公開表示名の昇順・利用者IDの昇順（API設計書 §3）。
 * カーソルは閲覧者・検索条件・並び順にひも付けて署名する。
 */
export async function searchAlumni(reader: AccessReader, viewer: Viewer, query: AlumniQuery) {
  const { q, department, entryYear, graduationYear, limit, cursor } = query;
  const codec = createCursorCodec({
    actorId: viewer.userId,
    list: "alumni",
    filters: { q, department, entryYear, graduationYear },
    sort: "displayName:asc,userId:asc",
  }, cursorPosition);
  const last = codec.decode(cursor);
  const filters = [
    q === undefined ? undefined : keywordCondition(q),
    department === undefined ? undefined : eq(profileRevisions.department, department),
    entryYear === undefined ? undefined : eq(profileRevisions.entryYear, entryYear),
    graduationYear === undefined ? undefined : eq(profileRevisions.graduationYear, graduationYear),
  ].filter((condition): condition is SQL => condition !== undefined);

  return queryListPage({
    authorized: listedInAlumniSearch(),
    filters: filters.length ? and(...filters) : undefined,
    after: last
      ? sql`(${profileRevisions.displayName}, ${communityUsers.userId}) > (${last[0]}, ${last[1]})`
      : undefined,
    limit,
    rows: (where, take) => profileSource(reader).where(where)
      .orderBy(asc(profileRevisions.displayName), asc(communityUsers.userId)).limit(take),
    count: async (where) => {
      const [{ total }] = await reader.select({ total: count() }).from(communityUsers)
        .innerJoin(profiles, eq(profiles.userId, communityUsers.userId))
        .innerJoin(profileRevisions, and(
          eq(profileRevisions.id, profiles.currentRevisionId), eq(profileRevisions.userId, profiles.userId),
        ))
        .where(where);
      return total;
    },
    cursorFor: (row) => codec.encode([row.displayName, row.userId]),
    toItem: (row) => toPublicProfile(viewer, row),
  });
}
