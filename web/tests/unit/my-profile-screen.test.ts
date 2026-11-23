import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProfileStatus } from "@/app/me/profile/profile-status";
import { saveOutcome } from "@/app/me/profile/save-outcome";
import type { MyProfile, ProfileReviewSummary } from "@/profile/my-profile";

/** マイプロフィール画面（GE-02）の保存応答の扱いと、公開状態・再公開申請の表示（#8 ①⑤）。 */
describe("保存応答の扱い", () => {
  it("200 でも版番号と公開状態を本文から確認できるまでは保存済みにしない（同じ再送キーで確認する）", () => {
    expect(saveOutcome(200, { data: { version: 3, state: "public" } })).toEqual({ kind: "saved", version: 3, state: "public" });
    expect(saveOutcome(200, { data: { version: 4, state: "hidden" } })).toEqual({ kind: "saved", version: 4, state: "hidden" });
    // 本文が途切れて読めない、または形式が違う。
    expect(saveOutcome(200, null)).toEqual({ kind: "unconfirmed" });
    expect(saveOutcome(200, { data: { state: "public" } })).toEqual({ kind: "unconfirmed" });
    expect(saveOutcome(200, { data: { version: "3", state: "public" } })).toEqual({ kind: "unconfirmed" });
    expect(saveOutcome(200, { data: { version: 3, state: "unknown" } })).toEqual({ kind: "unconfirmed" });
    expect(saveOutcome(503, null)).toEqual({ kind: "unconfirmed" });
  });

  it("確定した失敗は、それぞれの案内に分ける", () => {
    expect(saveOutcome(409, { error: { code: "VERSION_CONFLICT" } })).toEqual({ kind: "conflict" });
    expect(saveOutcome(422, { error: { fields: [
      { path: "displayName" }, { path: "optionalFields.bio.value" }, { path: "optionalFields.occupation" }, { path: "other" },
    ] } })).toEqual({ kind: "invalid", fields: ["displayName", "bio", "occupation"] });
    expect(saveOutcome(401, null)).toEqual({ kind: "unauthorized" });
    expect(saveOutcome(403, null)).toEqual({ kind: "unauthorized" });
    expect(saveOutcome(400, null)).toEqual({ kind: "failed" });
  });
});

describe("公開状態と再公開申請の表示", () => {
  const review = (status: ProfileReviewSummary["status"], extra: Partial<ProfileReviewSummary> = {}): ProfileReviewSummary => ({
    id: "review-1", status, submittedAt: "2026-11-20T01:00:00.000Z",
    decidedAt: status === "pending" ? null : "2026-11-21T02:30:00.000Z",
    decisionReason: null, version: 1, ...extra,
  });
  const render = (profileState: MyProfile["profileState"], latest: ProfileReviewSummary | null) => {
    const profile = {
      userId: "user-1", version: 2, profileState, baseRole: "alumni", isGraduating: false, searchOptIn: false,
      fields: { displayName: "あおい", department: null, entryYear: null, graduationYear: null, optionalFields: {} },
      review: latest,
    } satisfies MyProfile;
    return renderToStaticMarkup(createElement(ProfileStatus, { profile, headingId: "state" }));
  };

  it("承認で公開に戻った直後は、公開中と前回の審査結果（承認済み・審査日時）を分けて表示する", () => {
    const html = render("public", review("approved"));
    expect(html).toContain("公開中");
    expect(html).not.toContain("非表示");
    expect(html).toContain("前回の審査結果");
    expect(html).toContain("承認済み");
    expect(html).toContain("2026/11/21 11:30");
    expect(html).not.toContain("承認待ち");
  });

  it("再び非表示になった後は、過去の承認を前回の審査結果として示し、審査中の申請はないと案内する", () => {
    const html = render("hidden", review("approved"));
    expect(html).toContain("非表示");
    expect(html).toContain("審査中の申請はありません。");
    expect(html).toContain("前回の審査結果");
    expect(html).toContain("承認済み");
    expect(html).not.toContain("承認待ち");
  });

  it("審査中の申請は、承認待ちと申請日時を表示し、前回の審査結果とは表示しない", () => {
    const html = render("hidden", review("pending"));
    expect(html).toContain("審査中の申請");
    expect(html).toContain("承認待ち");
    expect(html).toContain("2026/11/20 10:00");
    expect(html).not.toContain("前回の審査結果");
  });

  it("却下された申請は、前回の審査結果として却下の理由を表示する", () => {
    const html = render("hidden", review("rejected", { decisionReason: "連絡先が残っています。" }));
    expect(html).toContain("審査中の申請はありません。");
    expect(html).toContain("却下");
    expect(html).toContain("連絡先が残っています。");
  });

  it("申請のない公開中のプロフィールには、再公開の申請欄を表示しない", () => {
    const html = render("public", null);
    expect(html).toContain("公開中");
    expect(html).not.toContain("再公開の申請");
  });
});
