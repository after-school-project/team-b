import type { ScreenSearchParams } from "@/auth/screen";
import { questionFilters } from "@/qa/questions";

const filterNames = ["q", "category", "resolution"] as const;
export type QuestionFilterValues = Partial<Record<(typeof filterNames)[number], string>>;

/** 画面のクエリーから、検索条件（空欄は指定なし）とカーソルを取り出す。配列（同名の複数指定）は形式の誤りとして扱う。 */
export function readQuestionParams(searchParams: ScreenSearchParams) {
  const values: QuestionFilterValues = {};
  const query = new URLSearchParams();
  let malformed = false;
  for (const name of [...filterNames, "cursor"] as const) {
    const raw = searchParams[name];
    if (Array.isArray(raw)) malformed = true;
    const value = typeof raw === "string" ? raw : "";
    if (name !== "cursor") values[name] = value;
    if (value.trim() !== "") query.set(name, value);
  }
  return { values, query, malformed };
}

/** 絞り込みの条件が指定されているか（「すべて」は指定なし）。 */
export function hasQuestionFilter(values: QuestionFilterValues): boolean {
  return Boolean(values.q?.trim() || values.category?.trim() || (values.resolution?.trim() && values.resolution !== "all"));
}

/** キーワードの修正が必要な場合の案内。判定には API と同じ検証を使う。空欄は指定なしとして扱う。 */
export function keywordError(value: string | undefined): string | undefined {
  if (!value || value.trim() === "" || questionFilters.q.safeParse(value).success) return undefined;
  return [...value.trim()].length > 100
    ? "キーワードは100文字以内で入力してください。"
    : "キーワードに使えない文字が含まれています。";
}
