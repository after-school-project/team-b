export const reportReasons = [
  "harassment", "personal_information", "spam", "suspicious_url", "inappropriate_recruitment", "other",
] as const;

export const reportReasonLabels = {
  harassment: "誹謗中傷・嫌がらせ",
  personal_information: "個人情報の公開",
  spam: "スパム・迷惑行為",
  suspicious_url: "不審なURL・詐欺の疑い",
  inappropriate_recruitment: "不適切な求人・勧誘",
  other: "その他",
} satisfies Record<(typeof reportReasons)[number], string>;

export const reportTargetTypes = ["question", "response", "profile", "account"] as const;
export const reportTargetLabels = {
  question: "質問", response: "回答・コメント・返信", profile: "プロフィール", account: "アカウント",
} satisfies Record<(typeof reportTargetTypes)[number], string>;

export const caseStatuses = ["unhandled", "in_progress", "closed"] as const;
export const caseStatusLabels = {
  unhandled: "未対応", in_progress: "対応中", closed: "対応済み",
} satisfies Record<(typeof caseStatuses)[number], string>;

export const casePriorities = ["unset", "normal", "high"] as const;
export const casePriorityLabels = {
  unset: "未設定", normal: "通常", high: "高",
} satisfies Record<(typeof casePriorities)[number], string>;

export const reportDetailMaxLength = 500;
