import type { ScreenSearchParams } from "@/auth/screen";

export function noticeListPosition(params: ScreenSearchParams): URLSearchParams {
  const position = new URLSearchParams();
  for (const key of ["state", "sort", "cursor"] as const) {
    const value = params[key];
    if (typeof value === "string" && value) position.set(key, value);
  }
  return position;
}

export function withNoticeQuery(path: string, query: URLSearchParams) {
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

export function myNoticeHref(options: {
  noticeId?: string;
  requestId?: string;
  requestCursor?: string;
  resubmit?: boolean;
} = {}, position?: URLSearchParams) {
  const query = new URLSearchParams(position);
  if (options.noticeId) query.set("notice", options.noticeId);
  if (options.requestId) query.set("request", options.requestId);
  if (options.requestCursor) query.set("requestCursor", options.requestCursor);
  if (options.resubmit) query.set("action", "resubmit");
  return withNoticeQuery("/me/notices", query);
}
