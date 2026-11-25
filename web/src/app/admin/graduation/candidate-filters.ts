import { graduationCandidateFilters } from "@/admin/graduation";

/** AD-13 の候補の検索条件。判定には API と同じ検証を使い、修正が必要な欄ごとに案内する。 */
export const candidateFilterNames = ["q", "department", "graduationYear"] as const;
export type CandidateFilterName = (typeof candidateFilterNames)[number];
export type CandidateFilterValues = Partial<Record<CandidateFilterName, string>>;
export type CandidateFilterErrors = Partial<Record<CandidateFilterName, string>>;

const labels: Record<CandidateFilterName, string> = { q: "キーワード", department: "学科", graduationYear: "卒業年度" };

export function candidateFilterErrors(values: CandidateFilterValues): CandidateFilterErrors {
  const errors: CandidateFilterErrors = {};
  for (const name of candidateFilterNames) {
    const value = values[name] ?? "";
    if (value.trim() === "" || graduationCandidateFilters[name].safeParse(value).success) continue;
    if (name === "graduationYear") errors[name] = `${labels[name]}は4桁の半角数字で入力してください。`;
    else if ([...value.trim()].length > 100) errors[name] = `${labels[name]}は100文字以内で入力してください。`;
    else errors[name] = `${labels[name]}に使えない文字が含まれています。`;
  }
  return errors;
}
