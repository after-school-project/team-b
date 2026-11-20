import { randomUUID } from "node:crypto";
import type { BetterAuthOptions } from "better-auth";
import { lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { rateLimit } from "@/db/auth-schema";

type RateLimitStorage = NonNullable<NonNullable<BetterAuthOptions["rateLimit"]>["customStorage"]>;

/** 削除するまでの保持期間。どの経路の時間窓（最長60秒）より十分に長くし、使用中の記録を消さない。 */
export const staleAfterMs = 24 * 60 * 60 * 1000;

async function deleteStaleRecords<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  current: number,
) {
  try {
    await database.delete(rateLimit).where(lt(rateLimit.lastRequest, current - staleAfterMs));
  } catch {
    // 削除できなくても判定は済んでいるため、認証は止めない。次の新しい送信元で再び削除する。
    console.error("回数制限の古い記録を削除できませんでした。");
  }
}

/**
 * 回数制限を固定の時間窓で数える保存処理。
 *
 * Better Auth 既定のDB保存は、最後に受け付けた試行から時間窓が空くまで回数を戻さない。
 * そのため、同じ回線から試行が途切れずに続くと、直近の時間窓の回数が上限未満でも429になる。
 * ここでは最初の試行を時間窓の起点にし、起点から時間窓が過ぎたら1から数え直す。
 * `last_request` 列には時間窓の起点を保存する。
 *
 * 判定と加算は1回の `INSERT ... ON CONFLICT` で行い、同時の試行でも上限を超えて受け付けない。
 * 拒否した試行も `max + 1` まで数え、保存値が `max + 1` なら上限に達した状態を表す。
 *
 * Better Auth の回数制限を使う全経路（ログイン以外の既定の制限を含む）に適用される。
 * 固定の時間窓のため、時間窓の境界をまたぐと短時間に最大で上限の2倍を受け付ける。
 * 新しい送信元の記録を作るときに、{@link staleAfterMs} より古い記録を削除する。
 */
export function fixedWindowRateLimitStorage<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
  now: () => number = () => Date.now(),
): RateLimitStorage {
  return {
    async consume(key, rule) {
      const current = now();
      const windowMs = rule.window * 1000;
      const expired = sql`rate_limit.last_request <= ${current - windowMs}`;
      const [row] = await database
        .insert(rateLimit)
        .values({ id: randomUUID(), key, count: 1, lastRequest: current })
        .onConflictDoUpdate({
          target: rateLimit.key,
          set: {
            count: sql`CASE WHEN ${expired} THEN 1 ELSE LEAST(rate_limit.count + 1, ${rule.max + 1}) END`,
            lastRequest: sql`CASE WHEN ${expired} THEN ${current} ELSE rate_limit.last_request END`,
          },
        })
        .returning({
          count: rateLimit.count,
          windowStart: rateLimit.lastRequest,
          // 競合せずに新しい行を作った場合だけ true（PostgreSQLのシステム列 xmax が0）。
          inserted: sql<boolean>`xmax = 0`,
        });
      if (!row) throw new Error("回数制限の記録を保存できませんでした。");
      if (row.inserted) await deleteStaleRecords(database, current);
      if (row.count <= rule.max) return { allowed: true, retryAfter: null };
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((row.windowStart + windowMs - current) / 1000)) };
    },
  };
}
