"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import styles from "./ConfirmDialog.module.css";

export type ConfirmDialogProps = {
  open: boolean;
  /** 操作の目的。 */
  title: string;
  /** 対象と操作結果の説明。 */
  children: ReactNode;
  /** 確定ボタンの名前。「はい」ではなく操作を表す。 */
  confirmLabel: string;
  /** 確定ボタンの種類。非表示・削除などは `danger`（既定）。 */
  tone?: "danger" | "primary";
  onConfirm: () => void;
  /** キャンセル・Esc で閉じたとき。操作は実行しない。 */
  onClose: () => void;
};

/**
 * 操作の確認ダイアログ（docs/DESIGN.md §8.4）。`dialog` 要素のモーダル表示を使い、フォーカスの移動・背面への移動の防止・
 * 閉じたときに元の操作へ戻す処理はブラウザーに任せる。最初のフォーカスはキャンセルに置き、誤って確定しないようにする。
 */
export function ConfirmDialog({ open, title, children, confirmLabel, tone = "danger", onConfirm, onClose }: ConfirmDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      onClose={() => { if (open) onClose(); }}
    >
      <h2 id={`${id}-title`} className={styles.title}>{title}</h2>
      <div id={`${id}-body`} className={styles.body}>{children}</div>
      <div className={styles.actions}>
        <button type="button" className={styles.cancelButton} onClick={onClose}>キャンセル</button>
        <button type="button" className={tone === "danger" ? styles.dangerButton : styles.primaryButton} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </dialog>
  );
}
