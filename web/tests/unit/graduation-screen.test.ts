import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { candidateFilterErrors, type CandidateFilterValues } from "@/app/admin/graduation/candidate-filters";
import { CandidateSearchForm } from "@/app/admin/graduation/candidate-search-form";
import { candidateLabel, candidatePage, mergeCandidates } from "@/app/admin/graduation/graduate-panel";
import { graduationPath } from "@/app/admin/graduation/graduation-path";
import { nameLabel, stateLabel } from "@/app/admin/graduation/labels";
import { graduationBatchSchema, graduationCorrectionSchema } from "@/admin/graduation";
import { graduationBatchLimit } from "@/admin/graduation-limits";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

/** 卒業区分の変更（AD-13）の画面の部品と入力の検証（#8 ⑥）。 */
describe("卒業区分の入力の検証", () => {
  const target = (index: number) => ({ userId: `user-${index}`, expectedVersion: 1 });
  const batch = (length: number) => ({ targets: Array.from({ length }, (_, index) => target(index)), confirmed: true });

  it("一括変更は1〜100人で、重複と最終確認なしを拒否する", () => {
    for (const length of [1, graduationBatchLimit]) expect(graduationBatchSchema.safeParse(batch(length)).success).toBe(true);
    for (const length of [0, graduationBatchLimit + 1]) expect(graduationBatchSchema.safeParse(batch(length)).success).toBe(false);
    expect(graduationBatchSchema.safeParse({ targets: [target(1), target(1)], confirmed: true }).success).toBe(false);
    for (const confirmed of [false, undefined, "true"]) {
      expect(graduationBatchSchema.safeParse({ ...batch(1), confirmed }).success).toBe(false);
    }
  });

  it("修正の所属は在校生・卒業生だけを受け付ける", () => {
    const correction = { userId: "user-1", expectedVersion: 1, baseRole: "student", isGraduating: true, confirmed: true };
    expect(graduationCorrectionSchema.safeParse(correction).success).toBe(true);
    for (const change of [{ baseRole: "staff" }, { isGraduating: null }, { confirmed: false }, { expectedVersion: 0 }, { appManager: true }]) {
      expect(graduationCorrectionSchema.safeParse({ ...correction, ...change }).success, JSON.stringify(change)).toBe(false);
    }
  });
});

describe("候補の検索条件", () => {
  it("修正が必要な欄だけにエラーを出し、欄に関連付けて入力を保つ", () => {
    const values: CandidateFilterValues = { q: "あ".repeat(101), department: "IT学科", graduationYear: "26" };
    expect(candidateFilterErrors({ q: " ", department: "", graduationYear: "" })).toEqual({});
    expect(candidateFilterErrors({ q: "𠮷".repeat(100), graduationYear: "2026" })).toEqual({});
    const errors = candidateFilterErrors(values);
    expect(errors).toEqual({
      q: "キーワードは100文字以内で入力してください。", graduationYear: "卒業年度は4桁の半角数字で入力してください。",
    });
    const html = renderToStaticMarkup(createElement(CandidateSearchForm, { mode: "graduate", values, errors }));
    const inputOf = (name: string) => html.match(new RegExp(`<input[^>]*id="candidate-${name}"[^>]*>`))![0];
    expect(inputOf("q")).toContain('aria-describedby="candidate-q-error candidate-q-help"');
    expect(inputOf("q")).toContain(`value="${"あ".repeat(101)}"`);
    expect(inputOf("q")).not.toContain("maxLength");
    expect(inputOf("graduationYear")).toContain('aria-invalid="true"');
    expect(inputOf("department")).not.toContain("aria-invalid");
    expect(html).toContain("検索条件を確認してください。（2件）");
    expect(html).not.toContain('name="mode"');
  });

  it("修正の検索・条件のクリアでは、修正の画面を保つ", () => {
    const html = renderToStaticMarkup(createElement(CandidateSearchForm, { mode: "correction", values: {}, errors: {} }));
    expect(html.match(/<input type="hidden" name="mode" value="correction"\/>/g)).toHaveLength(2);
  });
});

describe("画面の表示", () => {
  it("URL・区分・表示名を組み立てる", () => {
    expect(graduationPath("graduate")).toBe("/admin/graduation");
    expect(graduationPath("graduate", { q: "a b", department: undefined })).toBe("/admin/graduation?q=a+b");
    expect(graduationPath("history", { batchId: "b" })).toBe("/admin/graduation?mode=history&batchId=b");
    expect(stateLabel({ baseRole: "student", isGraduating: true })).toBe("在校生（卒業予定）");
    expect(stateLabel({ baseRole: "student", isGraduating: false })).toBe("在校生");
    expect(stateLabel({ baseRole: "alumni", isGraduating: false })).toBe("卒業生");
    expect(nameLabel(null)).toBe("非表示のプロフィール");
  });

  const person = (userId: string, displayName: string | null, version = 1) => ({
    userId, displayName, baseRole: "student" as const, isGraduating: true, department: null, entryYear: null, graduationYear: null, version,
  });

  it("確認ダイアログでは、同じ表示名の人を選び分けられるよう、必ずIDを併記する", () => {
    expect([person("a", "はる"), person("b", null)].map(candidateLabel)).toEqual(["はる（ID：a）", "非表示のプロフィール（ID：b）"]);
  });

  it("続きに同じ人が含まれていれば、位置を保って新しい版だけを使う", () => {
    const merged = mergeCandidates(
      [person("a", "あ", 3), person("b", "い", 1)], [person("b", "い（更新後）", 2), person("a", "あ（古い）", 1), person("c", "う")],
    );
    expect(merged.map(({ userId, displayName, version }) => [userId, displayName, version]))
      .toEqual([["a", "あ", 3], ["b", "い（更新後）", 2], ["c", "う", 1]]);
  });

  it("続きの候補の応答は、一覧と次のカーソルを読み取れる場合だけ使う", () => {
    expect(candidatePage({ data: { items: [] }, meta: { page: { nextCursor: null } } })).toEqual({ items: [], nextCursor: null });
    expect(candidatePage({ data: { items: [{ userId: "a" }] }, meta: { page: { nextCursor: "c" } } })?.nextCursor).toBe("c");
    for (const body of [null, {}, { data: {} }, { data: { items: [] } }, { data: { items: [] }, meta: { page: {} } }, { error: { code: "INVALID_CURSOR" } }]) {
      expect(candidatePage(body)).toBeNull();
    }
  });
});
