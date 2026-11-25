export const reviewStatuses = ["pending", "approved", "rejected", "all"] as const;
export type ReviewStatus = (typeof reviewStatuses)[number];

/** AD-15 のURL。申請の選択は `?review=[reviewId]` で表す（AD-05・AD-07 の `?request=` と同じ形）。 */
export function reviewsPath({ status, cursor, review }: { status: ReviewStatus; cursor?: string; review?: string }): string {
  const query = new URLSearchParams();
  if (status !== "pending") query.set("status", status);
  if (cursor) query.set("cursor", cursor);
  if (review) query.set("review", review);
  return `/admin/profile-reviews${query.size ? `?${query}` : ""}`;
}
