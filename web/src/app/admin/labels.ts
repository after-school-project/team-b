/** 管理画面の表示に使うラベルと日時の書式。 */

export const baseRoleLabels = { student: "在校生", alumni: "卒業生", staff: "学校職員" } as const;
export const accountStatusLabels = { active: "利用中", suspended: "停止中" } as const;
export const managerRoleLabels = { school: "学校管理者", app: "アプリ管理者", none: "管理権限なし" } as const;

export const reviewStatusLabels = { pending: "審査待ち", approved: "承認済み", rejected: "却下" } as const;

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" })
    .format(new Date(value));
}
