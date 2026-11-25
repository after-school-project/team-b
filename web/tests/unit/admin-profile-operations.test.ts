import { describe, expect, it } from "vitest";
import { reasonMaxLength } from "@/api/input-limits";
import { optionalReason, requiredReason } from "@/api/request";
import { reviewsPath } from "@/app/admin/profile-reviews/reviews-path";
import { reasonError } from "@/app/admin/reason-field";
import { outcomeMessage, submitOutcome } from "@/app/admin/submit-outcome";

/** 管理操作（AD-11・AD-15）の応答の扱いと、理由の入力の検証（#8 ⑤）。 */
describe("管理操作の応答", () => {
  const states = ["approved", "rejected"] as const;

  it("200でも、結果の状態を確認できるまで確定とみなさない", () => {
    expect(submitOutcome(200, { data: { state: "approved", resource: { type: "profile_review", id: "r1" } } }, states))
      .toEqual({ kind: "done", state: "approved", resourceId: "r1" });
    expect(submitOutcome(201, { data: { state: "approved" } }, states)).toEqual({ kind: "done", state: "approved", resourceId: null });
    for (const body of [null, {}, { data: null }, { data: { state: "hidden" } }, { data: { state: 1 } }]) {
      expect(submitOutcome(200, body, states)).toEqual({ kind: "unconfirmed" });
    }
  });

  it.each([
    [500, "unconfirmed"], [503, "unconfirmed"], [409, "conflict"], [422, "invalid"], [401, "unauthenticated"],
    [403, "denied"], [404, "denied"], [400, "failed"], [429, "failed"],
  ] as const)("HTTP %s は %s として扱う", (status, kind) => {
    expect(submitOutcome(status, null, states)).toEqual({ kind });
  });

  it("競合・認証切れ・権限喪失では、最新の内容を読み込む操作を示す", () => {
    for (const kind of ["conflict", "unauthenticated", "denied"] as const) expect(outcomeMessage(kind, "審査").reload).toBe(true);
    for (const kind of ["unconfirmed", "invalid", "failed"] as const) expect(outcomeMessage(kind, "審査").reload).toBe(false);
  });
});

describe("理由の入力", () => {
  const overLimit = "𠮷".repeat(reasonMaxLength + 1);
  // 空白だけの理由。DBの制約が空白とみなす U+0085（NEL）なども含む。
  const blanks = ["", "  ", "\n\t", "　", String.fromCharCode(0x85), String.fromCharCode(0x1c, 0x20)];

  it("必須の理由は、空白だけと上限超過を拒否し、コードポイントで1000文字まで受け付ける", () => {
    for (const value of blanks) expect(requiredReason.safeParse(value).success, JSON.stringify(value)).toBe(false);
    expect(requiredReason.safeParse(overLimit).success).toBe(false);
    expect(requiredReason.parse("𠮷".repeat(reasonMaxLength))).toHaveLength(reasonMaxLength * 2);
    expect(requiredReason.parse("1行目\r\n2行目")).toBe("1行目\n2行目");
    for (const value of ["NUL\0", String.fromCharCode(0xd800), null, undefined, 1]) {
      expect(requiredReason.safeParse(value).success).toBe(false);
    }
  });

  it("任意の理由は、省略・null・空白だけを null にそろえる", () => {
    for (const value of [undefined, null, ...blanks]) expect(optionalReason.parse(value)).toBeNull();
    expect(optionalReason.parse("理由")).toBe("理由");
    expect(optionalReason.safeParse(overLimit).success).toBe(false);
  });

  it("画面の案内は、サーバーが受け付ける理由を止めない", () => {
    expect(reasonError("𠮷".repeat(reasonMaxLength), "理由")).toBeNull();
    expect(reasonError("a\r\n".repeat(500), "理由")).toBeNull();
    expect(reasonError("   ", "却下の理由")).toBe("却下の理由を入力してください。");
    expect(reasonError(overLimit, "却下の理由")).toBe("却下の理由は1000文字以内で入力してください。");
  });
});

it("再公開審査のURLは、既定の状態を省き、申請の選択を review で表す", () => {
  expect(reviewsPath({ status: "pending" })).toBe("/admin/profile-reviews");
  expect(reviewsPath({ status: "all", cursor: "c", review: "r" })).toBe("/admin/profile-reviews?status=all&cursor=c&review=r");
});
