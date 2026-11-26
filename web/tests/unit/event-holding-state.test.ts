import { describe, expect, it } from "vitest";
import { resolveEventHoldingState } from "../../src/events/holding-state";

describe("イベントの開催状態と有効終了時刻", () => {
  const startsAt = new Date("2026-11-25T16:00:00Z"); // JST では11月26日01:00
  const endsAt = new Date("2026-11-26T01:00:00Z");

  it.each([
    ["直前", -1, "scheduled"],
    ["一致", 0, "ended"],
    ["直後", 1, "ended"],
  ])("明示終了日時の%s", (_, offset, holdingState) => {
    const referenceTime = new Date(endsAt.getTime() + offset);
    expect(resolveEventHoldingState({ startsAt, endsAt }, null, referenceTime))
      .toEqual({ holdingState, effectiveEndsAt: endsAt });
  });

  it.each([
    ["直前", "2026-11-26T14:59:59.999Z", "scheduled"],
    ["一致", "2026-11-26T15:00:00.000Z", "ended"],
    ["直後", "2026-11-26T15:00:00.001Z", "ended"],
  ])("終了未指定で開始日がUTCとJSTで異なる場合、JST翌日00:00の%s", (_, referenceTime, holdingState) => {
    expect(resolveEventHoldingState({ startsAt, endsAt: null }, null, new Date(referenceTime)))
      .toEqual({ holdingState, effectiveEndsAt: new Date("2026-11-27T00:00:00+09:00") });
  });

  it.each([
    ["月末", "2026-04-30T23:59:59+09:00", "2026-05-01T00:00:00+09:00"],
    ["年末", "2026-12-31T23:59:59+09:00", "2027-01-01T00:00:00+09:00"],
  ])("%sの翌日00:00に繰り上がる", (_, start, end) => {
    const effectiveEndsAt = new Date(end);
    expect(resolveEventHoldingState({ startsAt: new Date(start), endsAt: null }, null, effectiveEndsAt))
      .toEqual({ holdingState: "ended", effectiveEndsAt });
  });

  it.each([
    ["前", "2026-11-26T00:00:00Z"],
    ["後", "2026-11-26T02:00:00Z"],
  ])("終了時刻より%sに参照しても中止を優先する", (_, referenceTime) => {
    const cancelledAt = new Date("2026-11-25T23:00:00Z");
    expect(resolveEventHoldingState({ startsAt, endsAt }, cancelledAt, new Date(referenceTime)))
      .toEqual({ holdingState: "cancelled", effectiveEndsAt: endsAt });
  });

  it("同一入力と同一基準時刻で同じ結果を返す", () => {
    const publicRevision = { startsAt, endsAt: null };
    const referenceTime = new Date("2026-11-26T12:00:00Z");
    expect(resolveEventHoldingState(publicRevision, null, referenceTime))
      .toEqual(resolveEventHoldingState(publicRevision, null, referenceTime));
  });
});
