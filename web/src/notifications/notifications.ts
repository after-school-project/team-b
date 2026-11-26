import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { NotificationKind } from "@/api/notifications";
import { createCursorCodec, cursorTimestamp, parseListQuery, queryListPage } from "@/api/pagination";
import { ApiError } from "@/api/response";
import type { AccessReader, Viewer } from "@/auth/access";
import { ownedBy } from "@/auth/ownership";
import { notifications } from "@/db/moderation-schema";

/**
 * 通知の一覧・未読件数・既読（API-NT-01〜03、画面ID GE-06）。Issue #17 ②。
 *
 * - 一覧・件数・既読の対象は、受信者本人の通知だけ（`ownedBy`）。他人の通知は一覧・件数・カーソルに含まれず、
 *   既読の操作では存在しない通知と同じ 404 にする。停止中の利用者は、業務APIと画面の入口で拒否する。
 * - 一覧・件数の取得（GET）では既読にしない。既読は、受信者本人の既読の操作（POST）でだけ記録する。
 *   既読済みの通知を再度既読にしても、最初の既読時刻を変えない（API設計書 §3「版番号」、§10）。
 * - 通知に保存しているのは、種類ごとの定型文と本人向けの理由だけ（#47）。対象の題名・本文や操作者は返さない。
 *
 * 通知の対象の状態案内（`targetState`）と、対象への遷移（API-NT-04）は #17 ③ で追加する。
 */

/** API設計書 §5 NotificationView。`targetState` は #17 ③ で追加する。 */
export type NotificationView = {
  id: string;
  kind: NotificationKind;
  /** 種類ごとの定型文。本人向けの理由がある通知は、改行の後に理由が続く。 */
  message: string;
  createdAt: string;
  readAt: string | null;
};

/** 通知一覧のクエリー（API設計書 §3）。state=all/unread、既定は all。 */
export const notificationFilters = {
  state: z.enum(["all", "unread"]).default("all"),
};

export type NotificationQuery = ReturnType<typeof parseNotificationQuery>;

/** URLのクエリーを検証する。未定義の項目・値は 400 BAD_REQUEST。 */
export function parseNotificationQuery(url: URL) {
  return parseListQuery(url, notificationFilters);
}

const cursorPosition = z.tuple([z.string(), z.string()]);

/** 未読の通知。 */
const unread = () => isNull(notifications.readAt);

/**
 * 通知一覧（API-NT-01）。受信者本人の通知を、作成日時の降順・IDの降順で返す。
 * カーソルは閲覧者・絞り込み・並び順にひも付けて署名する。
 */
export async function listNotifications(reader: AccessReader, viewer: Viewer, query: NotificationQuery) {
  const { state, limit, cursor } = query;
  const codec = createCursorCodec({
    actorId: viewer.userId,
    list: "notifications",
    filters: { state },
    sort: "createdAt:desc,id:desc",
  }, cursorPosition);
  const last = codec.decode(cursor);

  return queryListPage({
    authorized: ownedBy(notifications.recipientId, viewer),
    filters: state === "unread" ? unread() : undefined,
    after: last
      ? sql`(${notifications.createdAt}, ${notifications.id}) < (${last[0]}::timestamptz, ${last[1]}::uuid)`
      : undefined,
    limit,
    rows: (where, take) => reader.select({
      id: notifications.id,
      kind: notifications.kind,
      message: notifications.publicMessage,
      createdAt: notifications.createdAt,
      readAt: notifications.readAt,
      cursorAt: cursorTimestamp(notifications.createdAt),
    }).from(notifications).where(where).orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(take),
    count: async (where) => {
      const [{ total }] = await reader.select({ total: count() }).from(notifications).where(where);
      return total;
    },
    cursorFor: (row) => codec.encode([row.cursorAt, row.id]),
    toItem: (row): NotificationView => ({
      id: row.id,
      kind: row.kind,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    }),
  });
}

/** 未読件数（API-NT-02）。受信者本人の未読の通知を、一覧と同じ条件で数える。ヘッダーとホームで使う。 */
export async function countUnreadNotifications(reader: AccessReader, viewer: Pick<Viewer, "userId">): Promise<number> {
  const [{ total }] = await reader.select({ total: count() }).from(notifications)
    .where(and(ownedBy(notifications.recipientId, viewer), unread()));
  return total;
}

type ReadWriter = Pick<PgDatabase<PgQueryResultHKT, Record<string, unknown>>, "select" | "update">;

/** 既読の操作の結果（MutationResult の resource・version・state）。版番号を持たないため version は null。 */
const readResult = (notificationId: string) => ({
  resource: { type: "notification", id: notificationId }, version: null, state: "read",
} as const);

/** 受信者本人の通知か確認する。存在しない通知と他人の通知は、どちらも 404 NOT_FOUND。 */
async function requireOwnNotification(tx: Pick<ReadWriter, "select">, actorId: string, notificationId: string) {
  const [row] = await tx.select({ id: notifications.id }).from(notifications)
    .where(and(eq(notifications.id, notificationId), ownedBy(notifications.recipientId, { userId: actorId })));
  if (!row) throw new ApiError("NOT_FOUND");
}

/**
 * 通知を既読にする（API-NT-03）。`commitMutation` の `execute` の中で、ロック後の DB 時刻 `now` を渡して呼ぶ。
 * 未読の場合だけ既読時刻を設定し、既読済みなら既読時刻を変えずに同じ結果を返す。
 * 同時に既読にした場合も、行の更新は1件ずつ行われ、後の更新は未読の条件に一致しないため、最初の既読時刻が残る。
 */
export async function markNotificationRead(
  tx: ReadWriter, input: { actorId: string; notificationId: string; now: Date },
) {
  const updated = await tx.update(notifications).set({ readAt: input.now })
    .where(and(
      eq(notifications.id, input.notificationId),
      ownedBy(notifications.recipientId, { userId: input.actorId }),
      unread(),
    ))
    .returning({ id: notifications.id });
  if (updated.length === 0) await requireOwnNotification(tx, input.actorId, input.notificationId);
  return readResult(input.notificationId);
}

/**
 * 確定済みの既読の操作を再送されたときの確認。通知の受信者は変わらないが、現在も本人の通知であることを確認する。
 * 既読時刻は変えず、通知や監査も追加しない。
 */
export async function authorizeNotificationReadReplay(
  tx: Pick<ReadWriter, "select">,
  input: { actorId: string; notificationId: string; original: { resource: { type: string; id: string } } },
) {
  const { resource } = input.original;
  if (resource.type !== "notification" || resource.id !== input.notificationId) throw new ApiError("NOT_FOUND");
  await requireOwnNotification(tx, input.actorId, input.notificationId);
}
