import type { EventListItem } from "@/events/event-list";
import type { HoldingState } from "@/events/holding-state";

export const holdingLabels = {
  scheduled: "開催予定", ended: "開催終了", cancelled: "開催中止",
} satisfies Record<HoldingState, string>;

export const formatLabels = {
  in_person: "対面", online: "オンライン", hybrid: "ハイブリッド",
} satisfies Record<EventListItem["format"], string>;

const dateTime = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo",
});

export function formatEventDateTime(value: string) {
  return dateTime.format(new Date(value));
}
