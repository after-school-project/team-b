import { alumniFilters } from "@/profile/public-profile";

export const alumniFilterNames = ["q", "department", "entryYear", "graduationYear"] as const;
export type AlumniFilterName = (typeof alumniFilterNames)[number];
export type AlumniFilterValues = Partial<Record<AlumniFilterName, string>>;
export type AlumniFieldErrors = Partial<Record<AlumniFilterName, string>>;

const labels: Record<AlumniFilterName, string> = {
  q: "キーワード", department: "学科", entryYear: "入学年度", graduationYear: "卒業年度",
};

function messageFor(name: AlumniFilterName, value: string): string {
  if (name === "entryYear" || name === "graduationYear") return `${labels[name]}は4桁の半角数字で入力してください。`;
  return [...value.trim()].length > 100
    ? `${labels[name]}は100文字以内で入力してください。`
    : `${labels[name]}に使えない文字が含まれています。`;
}

/**
 * 卒業生検索の条件のうち、修正が必要な欄と案内。判定には API と同じ検証（`alumniFilters`）を使う。
 * 空欄は条件の指定なしとして扱う。
 */
export function alumniFieldErrors(values: AlumniFilterValues): AlumniFieldErrors {
  const errors: AlumniFieldErrors = {};
  for (const name of alumniFilterNames) {
    const value = values[name] ?? "";
    if (value.trim() !== "" && !alumniFilters[name].safeParse(value).success) errors[name] = messageFor(name, value);
  }
  return errors;
}
