export const graduationModes = ["graduate", "correction", "history"] as const;
export type GraduationMode = (typeof graduationModes)[number];

export const graduationModeLabels: Record<GraduationMode, string> = {
  graduate: "卒業生への一括変更", correction: "区分の修正", history: "変更履歴",
};

/** AD-13 のURL。表示する機能を `mode`、修正する利用者を `user` で表す。履歴は `userId`・`batchId` で絞り込む。 */
export function graduationPath(mode: GraduationMode, params: Record<string, string | undefined> = {}): string {
  const query = new URLSearchParams();
  if (mode !== "graduate") query.set("mode", mode);
  for (const [name, value] of Object.entries(params)) if (value) query.set(name, value);
  return `/admin/graduation${query.size ? `?${query}` : ""}`;
}
