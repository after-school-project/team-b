/** 卒業区分の表示。 */
export type GraduationState = { baseRole: "student" | "alumni"; isGraduating: boolean };

export function stateLabel({ baseRole, isGraduating }: GraduationState): string {
  if (baseRole === "alumni") return "卒業生";
  return isGraduating ? "在校生（卒業予定）" : "在校生";
}

/** 公開表示名。非表示中の利用者は公開表示名がないため、利用者IDを併記して区別する。 */
export function nameLabel(displayName: string | null): string {
  return displayName ?? "非表示のプロフィール";
}
