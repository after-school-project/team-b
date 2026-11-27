import styles from "../admin.module.css";

export const requestKindLabels = { new: "新規申請", edit: "編集申請" } as const;
export const reviewLabels = { pending: "承認待ち", approved: "承認済み", rejected: "却下済み", withdrawn: "取り下げ済み" } as const;
export const publicationLabels = { public: "公開中", hidden: "強制非表示", deleted: "削除済み", unpublished: "未公開" } as const;
export const originLabels = { school: "学校公式", alumni: "卒業生投稿" } as const;
export const reviewBadge = { pending: styles.badgeWarning, approved: styles.badgeSuccess, rejected: styles.badgeDanger,
  withdrawn: styles.badgeInfo };
export const publicationBadge = { public: styles.badgeSuccess, hidden: styles.badgeWarning, deleted: styles.badgeInfo,
  unpublished: styles.badgeInfo };
