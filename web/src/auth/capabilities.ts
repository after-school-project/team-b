/** API設計書 §5 CapabilitySet。対象外の操作は false。表示の切替に使う値で、実行時はサーバーで再認可する。 */
export type CapabilitySet = Record<
  "canEdit" | "canDelete" | "canRespond" | "canResolve" | "canWithdraw" | "canResubmit" | "canCancel" | "canReview"
  | "canHide" | "canRestore", boolean
>;

export const noCapabilities: Readonly<CapabilitySet> = {
  canEdit: false, canDelete: false, canRespond: false, canResolve: false, canWithdraw: false, canResubmit: false,
  canCancel: false, canReview: false, canHide: false, canRestore: false,
};
