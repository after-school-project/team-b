import { sql } from "drizzle-orm";
import { cursorTimestamp } from "@/api/pagination";
import { eventRevisions, events } from "@/db/content-schema";

export type HoldingState = "scheduled" | "ended" | "cancelled";

const millisecondsPerHour = 60 * 60 * 1000;
const millisecondsPerDay = 24 * millisecondsPerHour;
const jstOffsetHours = 9;
const jstOffset = jstOffsetHours * millisecondsPerHour;

/**
 * 開催状態は本体の中止日時と公開版の日時から判定する。
 * 一覧のSQLでも、中止を優先し、有効終了時刻と同一の基準時刻を >= で比較する。
 */
export function resolveEventHoldingState(
  publicRevision: { startsAt: Date; endsAt: Date | null; endsAtHasSubmillisecond?: boolean },
  cancelledAt: Date | null,
  referenceTime: Date,
): { holdingState: HoldingState; effectiveEndsAt: Date } {
  const { startsAt, endsAt } = publicRevision;
  // UTC+09:00 にずらして開始日の境界を求め、翌日の午前0時をUTCに戻す。
  const jstStartDay = Math.floor((startsAt.getTime() + jstOffset) / millisecondsPerDay);
  const effectiveEndTime = endsAt?.getTime() ?? (jstStartDay + 1) * millisecondsPerDay - jstOffset;
  const now = referenceTime.getTime();
  // Date が切り捨てた明示終了の端数があれば、同じミリ秒の先頭ではまだ終了していない。
  const endsLaterInSameMillisecond = endsAt !== null && publicRevision.endsAtHasSubmillisecond;

  let holdingState: HoldingState = "scheduled";
  if (cancelledAt !== null) {
    holdingState = "cancelled";
  } else if (now > effectiveEndTime || (now === effectiveEndTime && !endsLaterInSameMillisecond)) {
    holdingState = "ended";
  }

  return { holdingState, effectiveEndsAt: new Date(effectiveEndTime) };
}

/** 公開版への JOIN 後に使用する、同じ UTC+09:00 の計算と開催状態判定。 */
export function eventHoldingStateSql(referenceTime: Date) {
  const jst = sql`make_interval(hours => ${jstOffsetHours})`;
  const effectiveEnd = sql`coalesce(${eventRevisions.endsAt},
    (date_trunc('day', ${eventRevisions.startsAt} AT TIME ZONE ${jst}) + interval '1 day') AT TIME ZONE ${jst})`;
  return sql<HoldingState>`CASE
    WHEN ${events.cancelledAt} IS NOT NULL THEN 'cancelled'
    WHEN ${referenceTime.toISOString()}::timestamptz >= ${effectiveEnd} THEN 'ended'
    ELSE 'scheduled'
  END`;
}

/** Date で端数が落ちる明示終了日時だけを、DB の精度の UTC 文字列で取得する。 */
export const eventExactEndsAt = sql<string | null>`case
  when mod(extract(microseconds FROM ${eventRevisions.endsAt}), 1000) <> 0
  then ${cursorTimestamp(eventRevisions.endsAt)}
end`;
