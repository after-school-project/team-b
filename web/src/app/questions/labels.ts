import type { QuestionListItem } from "@/qa/questions";

export const resolutionLabels: Record<QuestionListItem["resolution"], string> = { open: "未解決", resolved: "解決済み" };

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" })
    .format(new Date(value));
}
