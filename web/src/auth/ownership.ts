import { eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { ApiError } from "@/api/response";
import type { Viewer } from "./access";

/**
 * 所有者による本人判定（Issue #7 ④、共通認可条件表 §1・§2）。
 *
 * 「本人」は、セッションから特定した利用者ID（`viewer.userId`）とDB上の所有者IDの一致で判定する。
 * リクエストで送られた所有者ID・actorId は判定に使わない。
 *
 * 本人用データ（本人の一覧・申請・通知など）は、他人が要求しても存在の有無を明かさない。
 * 他人のデータと存在しないデータは、同じ 404 NOT_FOUND で区別せずに拒否する。
 */

type Owner = Pick<Viewer, "userId">;

/** セッションの利用者が、DB上の所有者IDの本人か。 */
export function isOwner(viewer: Owner, ownerId: string | null | undefined): boolean {
  return ownerId != null && ownerId === viewer.userId;
}

/**
 * 本人用の一覧・取得で、取得条件に加える所有者の条件。
 * 他人の行は取得結果・件数・カーソルに含まれず、ID指定の取得では存在しない対象と同じ結果になる。
 */
export function ownedBy(ownerColumn: PgColumn, viewer: Owner): SQL {
  return eq(ownerColumn, viewer.userId);
}

/**
 * 取得した本人用データの所有者を確認する。対象がない場合も、他人のデータの場合も 404 NOT_FOUND を投げる。
 * 取得条件に所有者を含められない場合（親の所有者で判定する申請など）に使う。
 */
export function requireOwned<T>(row: T | null | undefined, ownerOf: (row: T) => string | null, viewer: Owner): T {
  if (row == null || !isOwner(viewer, ownerOf(row))) throw new ApiError("NOT_FOUND");
  return row;
}
