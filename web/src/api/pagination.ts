import { createHmac, timingSafeEqual } from "node:crypto";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson, type JsonValue } from "./canonical-json";
import { parseQuery } from "./request";
import { ApiError, type PageInfo } from "./response";

const maxCursorLength = 4096;
const limitSchema = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(50));

export function parseListQuery<T extends z.ZodRawShape>(url: URL, filters: T) {
  return parseQuery(url, { ...filters, limit: limitSchema.default(20), cursor: z.string().optional() });
}

type CursorScope = {
  actorId: string;
  list: string;
  filters: { readonly [key: string]: JsonValue | undefined };
  sort: string;
};

export function createCursorCodec<T extends readonly JsonValue[]>(
  scope: CursorScope,
  position: z.ZodType<T>,
  secret = process.env.BETTER_AUTH_SECRET,
) {
  if (!secret || secret.length < 32) throw new Error("カーソル署名用のサーバー設定が必要です。");
  const scopeJson = canonicalJson(scope);
  const signature = (payload: string) => createHmac("sha256", secret)
    .update("team-b:api:v1:cursor\0").update(scopeJson).update("\0").update(payload).digest();

  return {
    encode(last: T): string {
      const payload = Buffer.from(canonicalJson(position.parse(last))).toString("base64url");
      const token = payload + "." + signature(payload).toString("base64url");
      if (token.length > maxCursorLength) throw new Error("カーソルが上限を超えました。");
      return token;
    },
    decode(cursor: string | undefined): T | null {
      if (cursor === undefined) return null;
      if (cursor.length <= maxCursorLength && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) {
        const [payload, mac] = cursor.split(".");
        const expected = signature(payload);
        if (timingSafeEqual(expected, Buffer.from(mac, "base64url")) &&
          expected.toString("base64url") === mac) {
          const decoded = position.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
          if (decoded.success) return decoded.data;
        }
      }
      throw new ApiError("INVALID_CURSOR");
    },
  };
}

/**
 * カーソルに入れる日時を、DBの精度（マイクロ秒）のまま UTC の文字列として取得する。
 * `Date` を経由するとミリ秒に切り捨てられ、同じミリ秒内の行がページの境目で抜けるため、
 * カーソルの日時はこの値を使い、比較では `::timestamptz` に戻す。
 */
export function cursorTimestamp(column: SQLWrapper): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function allOf(...conditions: (SQL | undefined)[]): SQL {
  return sql.join(conditions.filter((condition) => condition !== undefined).map((condition) => sql`(${condition})`),
    sql` AND `);
}

type ListQuery<T, Item> = {
  /**
   * 現在の認可で取得できる範囲（公開条件・所有者など）。件数と各ページの両方に必ず適用する。
   * 権限外のデータを数えてから取り除くと、件数・カーソルから存在が分かるため、取得条件として渡す。
   */
  authorized: SQL;
  /** 利用者が指定した検索条件。件数にも同じ条件を適用する。 */
  filters?: SQL;
  /** 前ページの最後の行より後ろを表す条件。先頭ページでは省略する。件数には適用しない。 */
  after?: SQL;
  limit: number;
  /** `where` を満たす行を並び順で最大 `take` 件取得する。 */
  rows: (where: SQL, take: number) => Promise<T[]>;
  /** `where` を満たす行の件数を返す。 */
  count: (where: SQL) => Promise<number>;
  /** 返した最後の行から次ページのカーソルを作る。カーソル用の列（`cursorTimestamp` など）を使える。 */
  cursorFor: (last: T) => string;
  /** 取得した行を返却項目（DTO）へ変換する。カーソル用の列など、DTO にない値はここで除く。 */
  toItem: (row: T) => Item;
};

/**
 * 認可条件を件数・各ページ・カーソルに同じように適用して一覧を返す（API設計書 §3）。
 * 次ページのカーソルは返した行からだけ作るため、権限外のデータの位置もカーソルに含まれない。
 * 応答の各項目は `toItem` で変換した値だけにする。トランザクション内でも使えるよう、行と件数は順に取得する。
 */
export async function queryListPage<T, Item>(query: ListQuery<T, Item>) {
  // 括弧のない OR を含む条件を渡されても、認可条件が外れないよう各条件を括弧で囲む。
  const where = allOf(query.authorized, query.filters);
  const rows = await query.rows(allOf(where, query.after), query.limit + 1);
  if (rows.length > query.limit + 1) throw new Error("一覧の取得件数が上限を超えました。");
  const totalCount = await query.count(where);
  const { data, page } = listPage(rows, query.limit, totalCount, query.cursorFor);
  return { data: { items: data.items.map((row) => query.toItem(row)) }, page };
}

// Query at most limit + 1 authorized rows in cursor order, and count with the same filters and authorization.
export function listPage<T>(rows: readonly T[], limit: number, totalCount: number, cursorFor: (last: T) => string) {
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const page: PageInfo = {
    limit, hasMore, nextCursor: hasMore ? cursorFor(items[items.length - 1]) : null, totalCount,
  };
  return { data: { items }, page };
}
