"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import type { Category } from "@/qa/questions";
import styles from "./page.module.css";

type Values = { title: string; categoryCode: string; bodyMarkdown: string };
type Edit = { id: string; version: number; values: Values };
type FieldErrors = Partial<Record<keyof Values, string>>;
type SaveResponse = {
  data?: { resource?: { type: string; id: string } };
  error?: { code: string; fields?: { path: string; message: string }[] };
};

const fallbackErrors = {
  title: "タイトルは100文字以内で入力してください。",
  categoryCode: "カテゴリーを選んでください。",
  bodyMarkdown: "本文は10,000文字以内で入力し、Markdownの書き方を確認してください。",
};

export function QuestionForm({ categories, cancelHref, edit }: {
  categories: Category[];
  cancelHref: string;
  edit?: Edit;
}) {
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false);
  const pending = useRef<{ body: string; key: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || conflict) return;
    const form = new FormData(event.currentTarget);
    const values = {
      title: String(form.get("title") ?? "").trim(),
      categoryCode: String(form.get("categoryCode") ?? ""),
      bodyMarkdown: String(form.get("bodyMarkdown") ?? ""),
    };
    const found: FieldErrors = {};
    if (!values.title || [...values.title].length > 100) found.title = fallbackErrors.title;
    if (!values.categoryCode) found.categoryCode = fallbackErrors.categoryCode;
    if (!values.bodyMarkdown.trim() || [...values.bodyMarkdown].length > 10_000) found.bodyMarkdown = fallbackErrors.bodyMarkdown;
    setErrors(found);
    if (Object.keys(found).length) {
      setNotice("入力内容を確認してください。");
      return;
    }

    const body = JSON.stringify(edit ? { ...values, expectedVersion: edit.version } : values);
    const key = pending.current?.body === body ? pending.current.key : crypto.randomUUID();
    pending.current = { body, key };
    inFlight.current = true;
    setSending(true);
    setNotice("");
    try {
      const response = await fetch(edit ? `/api/v1/questions/${encodeURIComponent(edit.id)}` : "/api/v1/questions", {
        method: edit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body,
      });
      const result: SaveResponse | null = await response.json().catch(() => null);
      const resource = result?.data?.resource;
      if (response.ok && resource?.type === "question" && typeof resource.id === "string") {
        router.replace(`/questions/${encodeURIComponent(resource.id)}`);
        router.refresh();
        return;
      }
      if (!result || response.ok || response.status >= 500) throw new Error("Save result unavailable");
      pending.current = null;
      if (response.status === 409 && result.error?.code === "VERSION_CONFLICT") {
        setConflict(true);
        setNotice("質問が更新されています。入力内容を控えてから、最新の内容を読み込んでください。");
      } else if (response.status === 422) {
        const fieldErrors: FieldErrors = {};
        for (const { path, message } of result.error?.fields ?? []) {
          if (path === "title" || path === "categoryCode" || path === "bodyMarkdown") {
            fieldErrors[path] ??= message || fallbackErrors[path];
          }
        }
        setErrors(fieldErrors);
        setNotice("入力内容を確認してください。");
      } else if ([401, 403, 404].includes(response.status)) {
        setNotice("現在この質問を保存できません。ログイン状態や投稿・編集の権限を確認してください。");
      } else {
        setNotice("質問を保存できませんでした。時間をおいてもう一度お試しください。");
      }
    } catch {
      setNotice("保存結果を確認できませんでした。内容を変えずにもう一度送信すると、同じ操作として確認できます。");
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <form className={styles.filters} method="post" onSubmit={submit} noValidate aria-busy={sending}>
      {notice ? <p className={styles.formError} role="alert">{notice}</p> : null}
      <div className={styles.field}>
        <label className={styles.label} htmlFor="question-title">タイトル</label>
        <input className={styles.input} id="question-title" name="title" required readOnly={sending}
          defaultValue={edit?.values.title} aria-invalid={Boolean(errors.title)}
          aria-describedby={errors.title ? "question-title-help question-title-error" : "question-title-help"} />
        <p className={styles.help} id="question-title-help">100文字以内</p>
        {errors.title ? <p className={styles.fieldError} id="question-title-error">{errors.title}</p> : null}
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="question-category">カテゴリー</label>
        <select className={styles.input} id="question-category" name="categoryCode" required disabled={sending}
          defaultValue={edit?.values.categoryCode ?? ""} aria-invalid={Boolean(errors.categoryCode)}
          aria-describedby={errors.categoryCode ? "question-category-error" : undefined}>
          <option value="">選択してください</option>
          {categories.map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
        </select>
        {errors.categoryCode ? <p className={styles.fieldError} id="question-category-error">{errors.categoryCode}</p> : null}
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="question-body">本文</label>
        <textarea className={styles.questionBody} id="question-body" name="bodyMarkdown" required readOnly={sending}
          rows={10} defaultValue={edit?.values.bodyMarkdown} aria-invalid={Boolean(errors.bodyMarkdown)}
          aria-describedby={errors.bodyMarkdown ? "question-body-help question-body-error" : "question-body-help"} />
        <p className={styles.help} id="question-body-help">
          10,000文字以内。Markdownが使えます。HTML、脚注、HTTP・HTTPS以外のリンクは使えません。
          山かっこを文字として書くときはコード（`）で囲んでください。
        </p>
        {errors.bodyMarkdown ? <p className={styles.fieldError} id="question-body-error">{errors.bodyMarkdown}</p> : null}
      </div>
      <div className={styles.actions}>
        <button className={styles.primaryButton} type="submit" disabled={sending || conflict}>
          {sending ? "送信中…" : edit ? "保存する" : "投稿する"}
        </button>
        {conflict ? <button className={styles.textButton} type="button" onClick={() => window.location.reload()}>
          最新の内容を読み込む
        </button> : null}
        <Link className={styles.formLink} href={cancelHref}>キャンセル</Link>
      </div>
    </form>
  );
}
