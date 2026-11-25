"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { GraduationCandidate } from "@/admin/graduation";
import { graduationBatchLimit } from "@/admin/graduation-limits";
import { ConfirmDialog } from "@/components/dialog/ConfirmDialog";
import admin from "../admin.module.css";
import { outcomeMessage } from "../submit-outcome";
import { useSubmission } from "../use-submission";
import { graduationPath } from "./graduation-path";
import { nameLabel } from "./labels";
import styles from "./page.module.css";

type Page = { items: GraduationCandidate[]; nextCursor: string | null };

/** 表示した時点の対象。版番号が変われば別の対象として扱い、古い選択を引き継がない。 */
const keyOf = ({ userId, version }: GraduationCandidate) => `${version}:${userId}`;

/** 確認ダイアログの表示名。一覧に同じ表示名の人がいても取り違えないよう、必ず利用者IDを併記する。 */
export function candidateLabel({ userId, displayName }: GraduationCandidate): string {
  return `${nameLabel(displayName)}（ID：${userId}）`;
}

/**
 * 一覧と続きを合わせる。並行更新で一覧の位置が変わると続きに同じ人が含まれることがあるため、IDで重複を除き（API設計書 §3）、
 * 新しい版の内容を使う。
 */
export function mergeCandidates(
  initial: readonly GraduationCandidate[], more: readonly GraduationCandidate[],
): GraduationCandidate[] {
  const byId = new Map<string, GraduationCandidate>();
  for (const item of [...initial, ...more]) {
    const existing = byId.get(item.userId);
    if (!existing || existing.version < item.version) byId.set(item.userId, item);
  }
  return [...byId.values()];
}

/** 候補の取得（API-GR-01）の応答から、一覧と次のカーソルを取り出す。読み取れなければ null。 */
export function candidatePage(body: unknown): Page | null {
  const value = body as { data?: { items?: unknown }; meta?: { page?: { nextCursor?: unknown } } } | null;
  const cursor = value?.meta?.page?.nextCursor;
  if (!Array.isArray(value?.data?.items) || (cursor !== null && typeof cursor !== "string")) return null;
  return { items: value.data.items as GraduationCandidate[], nextCursor: cursor };
}

/** 卒業予定の在校生を選び、確認のうえ卒業生へ一括変更する（AD-13、API-GR-02）。 */
export function GraduatePanel({ items: initialItems, nextCursor: initialCursor, totalCount, apiQuery }: Page & {
  totalCount: number;
  /** 続きを取得するときの検索条件（cursor を除く）。 */
  apiQuery: string;
}) {
  const router = useRouter();
  const id = useId();
  /** 「さらに表示」で取得した続き。 */
  const [more, setMore] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  /** 変更が確定し、最新の一覧を受け取るまで表示しない対象。 */
  const [changedKeys, setChangedKeys] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [alert, setAlert] = useState<{ message: string; reload: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** 確認ダイアログに示した対象。表示中に一覧が変わっても、示した対象だけを送る。 */
  const [confirmed, setConfirmed] = useState<readonly GraduationCandidate[]>([]);
  const [done, setDone] = useState<{ count: number; batchId: string | null } | null>(null);
  const alertBox = useRef<HTMLDivElement>(null);
  const result = useRef<HTMLParagraphElement>(null);
  /** 進行中の続きの取得。変更が確定したら中止し、変更前に取得した内容を使わない。 */
  const loadingRequest = useRef<AbortController | null>(null);
  const { sending, submit } = useSubmission("/api/v1/admin/graduation/changes", ["applied"]);

  const items = mergeCandidates(initialItems, more?.items ?? []).filter((item) => !changedKeys.has(keyOf(item)));
  const selected = items.filter((item) => selectedKeys.has(keyOf(item)));
  const nextCursor = more ? more.nextCursor : initialCursor;
  const allSelected = items.length > 0 && selected.length === items.length;

  useEffect(() => {
    if (alert) alertBox.current?.focus();
  }, [alert]);
  useEffect(() => {
    if (done) result.current?.focus();
  }, [done]);
  useEffect(() => () => loadingRequest.current?.abort(), []);

  function toggle(targets: readonly GraduationCandidate[], checked: boolean) {
    setError(null);
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const item of targets) {
        if (checked) next.add(keyOf(item));
        else next.delete(keyOf(item));
      }
      return next;
    });
  }

  async function loadMore() {
    if (loadingRequest.current || !nextCursor) return;
    const controller = new AbortController();
    loadingRequest.current = controller;
    setLoading(true);
    setLoadError(null);
    let page: Page | null = null;
    try {
      const query = new URLSearchParams(apiQuery);
      query.set("cursor", nextCursor);
      const response = await fetch(`/api/v1/admin/graduation/candidates?${query}`, { signal: controller.signal });
      page = response.ok ? candidatePage(await response.json()) : null;
    } catch {
      // 下で、読み込めなかったことを案内する。
    }
    // 中止した取得の結果は、受け取り終えていても使わない。
    if (controller.signal.aborted) return;
    loadingRequest.current = null;
    if (page) setMore({ items: [...more?.items ?? [], ...page.items], nextCursor: page.nextCursor });
    else setLoadError("続きを読み込めませんでした。もう一度お試しください。");
    setLoading(false);
  }

  /** 進行中の続きの取得を中止し、読み込み済みの続きも捨てる。 */
  function discardMore() {
    loadingRequest.current?.abort();
    loadingRequest.current = null;
    setLoading(false);
    setLoadError(null);
    setMore(null);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    setAlert(null);
    const found = selected.length === 0 ? "卒業生に変更する人を選択してください。"
      : selected.length > graduationBatchLimit
        ? `一度に変更できるのは${graduationBatchLimit}人までです。選択を減らしてください。（現在${selected.length}人）` : null;
    setError(found);
    if (found) return;
    setConfirmed(selected);
    setConfirming(true);
  }

  async function onConfirm() {
    setConfirming(false);
    const targets = confirmed;
    const outcome = await submit({
      targets: targets.map(({ userId, version }) => ({ userId, expectedVersion: version })), confirmed: true,
    });
    if (!outcome) return;
    if (outcome.kind === "done") {
      setChangedKeys((current) => new Set([...current, ...targets.map(keyOf)]));
      setSelectedKeys(new Set());
      discardMore();
      setDone({ count: targets.length, batchId: outcome.resourceId });
      router.refresh();
      return;
    }
    setDone(null);
    setAlert(outcomeMessage(outcome.kind, "卒業生への変更"));
  }

  return (
    <section className={admin.operationCard} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className={admin.sectionTitle}>
        卒業予定の在校生<span className={admin.count}>{totalCount}人</span>
      </h2>
      {done ? (
        <div className={styles.result}>
          <p ref={result} className={admin.success} role="status" tabIndex={-1}>{done.count}人を卒業生に変更しました。</p>
          {done.batchId ? (
            <p className={admin.links}><Link href={graduationPath("history", { batchId: done.batchId })}>この変更の履歴を見る</Link></p>
          ) : null}
        </div>
      ) : null}
      {items.length === 0 ? (
        <p className={admin.text}>条件に合う卒業予定の在校生はいません。</p>
      ) : (
        <form className={admin.form} onSubmit={onSubmit} noValidate aria-label="卒業生への一括変更">
          {alert ? (
            <div ref={alertBox} className={admin.formError} role="alert" tabIndex={-1}>
              <p>{alert.message}</p>
              {alert.reload ? (
                <button type="button" className={admin.secondaryButton} onClick={() => window.location.reload()}>
                  最新の内容を読み込む
                </button>
              ) : null}
            </div>
          ) : null}
          <fieldset
            className={styles.candidates}
            aria-describedby={[error ? `${id}-error` : "", `${id}-count`].filter(Boolean).join(" ")}
          >
            <legend className={admin.label}>変更する人</legend>
            <label className={styles.checkbox}>
              <input
                type="checkbox" checked={allSelected} disabled={sending}
                onChange={(event) => toggle(items, event.target.checked)}
              />
              表示中の{items.length}人をすべて選択
            </label>
            <ul className={admin.list}>
              {items.map((item) => (
                <li key={item.userId} className={styles.candidate}>
                  <label className={styles.checkbox}>
                    <input
                      type="checkbox" checked={selectedKeys.has(keyOf(item))} disabled={sending}
                      onChange={(event) => toggle([item], event.target.checked)}
                      aria-describedby={`${id}-${item.userId}`}
                    />
                    {nameLabel(item.displayName)}
                  </label>
                  <span id={`${id}-${item.userId}`} className={admin.meta}>
                    {item.department ?? "学科未設定"}・卒業年度：{item.graduationYear ?? "未設定"}・ID：{item.userId}
                  </span>
                </li>
              ))}
            </ul>
          </fieldset>
          {nextCursor ? (
            <div className={admin.actions}>
              <button type="button" className={admin.secondaryButton} disabled={loading || sending} onClick={loadMore}>
                {loading ? "読み込み中…" : "さらに表示"}
              </button>
              <p className={admin.text}>{items.length}人を表示中</p>
            </div>
          ) : null}
          {loadError ? <p className={admin.fieldError} role="alert">{loadError}</p> : null}
          {error ? <p id={`${id}-error`} className={admin.fieldError} role="alert">{error}</p> : null}
          <div className={admin.actions}>
            <button type="submit" className={admin.primaryButton} disabled={sending}>
              {sending ? "変更中…" : "選択した人を卒業生に変更する"}
            </button>
            <p id={`${id}-count`} className={admin.text} role="status">{selected.length}人を選択中</p>
          </div>
        </form>
      )}

      <ConfirmDialog
        open={confirming}
        title={`${confirmed.length}人を卒業生に変更しますか？`}
        confirmLabel="卒業生に変更する"
        tone="primary"
        onConfirm={onConfirm}
        onClose={() => setConfirming(false)}
      >
        <p>所属を「在校生（卒業予定）」から「卒業生」に変更します。投稿・プロフィール・管理権限はそのままです。</p>
        <ul className={styles.targets} tabIndex={0} aria-label="変更する人">
          {confirmed.map((item) => <li key={item.userId}>{candidateLabel(item)}</li>)}
        </ul>
      </ConfirmDialog>
    </section>
  );
}
