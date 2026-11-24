import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AlumniSearchForm } from "@/app/alumni/alumni-search-form";
import { alumniFieldErrors, type AlumniFilterValues } from "@/app/alumni/field-errors";

/** 卒業生検索（GE-04）の条件の検証と、欄ごとのエラー表示（#8 ④、docs/DESIGN.md §8.2）。 */
describe("検索条件の欄ごとの検証", () => {
  it("空欄と、APIが受け付ける値にはエラーを出さない", () => {
    expect(alumniFieldErrors({})).toEqual({});
    expect(alumniFieldErrors({ q: "  ", department: "", entryYear: "", graduationYear: "" })).toEqual({});
    expect(alumniFieldErrors({ q: ` ${"𠮷".repeat(100)} `, department: "IT学科", entryYear: "2024", graduationYear: "2026" })).toEqual({});
  });

  it("修正が必要な欄だけにエラーを出す", () => {
    expect(alumniFieldErrors({ q: "𠮷".repeat(101), department: "IT学科" })).toEqual({
      q: "キーワードは100文字以内で入力してください。",
    });
    expect(alumniFieldErrors({ q: "あおい", department: "あ".repeat(101) })).toEqual({
      department: "学科は100文字以内で入力してください。",
    });
    expect(alumniFieldErrors({ q: "NUL\0", entryYear: "26", graduationYear: "２０２６" })).toEqual({
      q: "キーワードに使えない文字が含まれています。",
      entryYear: "入学年度は4桁の半角数字で入力してください。",
      graduationYear: "卒業年度は4桁の半角数字で入力してください。",
    });
  });
});

describe("検索フォームのエラー表示", () => {
  const render = (values: AlumniFilterValues) =>
    renderToStaticMarkup(createElement(AlumniSearchForm, { values, errors: alumniFieldErrors(values) }));
  const inputOf = (html: string, id: string) => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))![0];

  it("エラーのある欄だけを aria-invalid とし、エラーを aria-describedby で関連付けて、入力した内容を保つ", () => {
    const html = render({ q: "あ".repeat(101), department: "IT学科", entryYear: "26" });
    expect(inputOf(html, "alumni-q")).toContain('aria-invalid="true"');
    expect(inputOf(html, "alumni-q")).toContain('aria-describedby="alumni-q-error alumni-q-help"');
    expect(inputOf(html, "alumni-q")).toContain(`value="${"あ".repeat(101)}"`);
    expect(html).toContain('id="alumni-q-error"');
    expect(inputOf(html, "alumni-entry")).toContain('aria-describedby="alumni-entry-error alumni-year-help"');
    for (const id of ["alumni-department", "alumni-graduation"]) expect(inputOf(html, id)).not.toContain("aria-invalid");
    expect(inputOf(html, "alumni-department")).not.toContain("aria-describedby");
    expect(html).not.toContain("alumni-department-error");
    expect(html).toContain("検索条件を確認してください。（2件）");
  });

  it("エラーがなければ、案内も aria-invalid も出さない", () => {
    const html = render({ q: "あおい" });
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain('role="alert"');
    expect(inputOf(html, "alumni-q")).toContain('aria-describedby="alumni-q-help"');
  });
});
