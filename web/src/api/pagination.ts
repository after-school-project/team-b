import { createHmac, timingSafeEqual } from "node:crypto";
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

// Query at most limit + 1 authorized rows in cursor order, and count with the same filters and authorization.
export function listPage<T>(rows: readonly T[], limit: number, totalCount: number, cursorFor: (last: T) => string) {
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const page: PageInfo = {
    limit, hasMore, nextCursor: hasMore ? cursorFor(items[items.length - 1]) : null, totalCount,
  };
  return { data: { items }, page };
}
