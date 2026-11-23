"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { MyProfile } from "@/profile/my-profile";
import { countCharacters, displayNameMaxLength, optionalFieldLimits } from "@/profile/limits";
import styles from "./page.module.css";
import { ProfileStatus } from "./profile-status";
import { saveOutcome, type SaveOutcome, type SavedFieldError } from "./save-outcome";

type FieldName = "bio" | "occupation" | "interests";
type Visibility = "members" | "self";
type OptionalFieldState = { value: string; visibility: Visibility };
type FormState = {
  displayName: string;
  searchOptIn: boolean;
  optionalFields: Record<FieldName, OptionalFieldState>;
};
type FieldErrors = Partial<Record<"displayName" | FieldName, string>>;
type Notice = { kind: "success" | "error"; message: string; reload?: boolean } | null;

const optionalFieldOrder: readonly FieldName[] = ["bio", "occupation", "interests"];
const optionalFieldLabels: Record<FieldName, string> = { bio: "自己紹介", occupation: "職種", interests: "関心分野" };
const visibilityLabels: Record<Visibility, string> = { members: "ログインした利用者に公開", self: "自分だけ" };
const baseRoleLabels: Record<MyProfile["baseRole"], string> = { student: "在校生", alumni: "卒業生", staff: "学校職員" };
const conflictMessage = "内容が更新されています。最新の内容を確認してください。";
const failureMessage = "保存できませんでした。時間をおいてもう一度お試しください。";
const unconfirmedMessage =
  "保存できたか確認できませんでした。内容を変えずにもう一度「保存する」を押すと、同じ保存として確認します。";

function initialState(profile: MyProfile): FormState {
  const field = (name: FieldName): OptionalFieldState => ({
    value: profile.fields.optionalFields[name]?.value ?? "",
    visibility: profile.fields.optionalFields[name]?.visibility ?? "self",
  });
  return {
    displayName: profile.fields.displayName,
    searchOptIn: profile.searchOptIn,
    optionalFields: { bio: field("bio"), occupation: field("occupation"), interests: field("interests") },
  };
}

function validate(form: FormState): FieldErrors {
  const errors: FieldErrors = {};
  const name = form.displayName.trim();
  if (!name) errors.displayName = "公開表示名を入力してください。";
  else if (countCharacters(name) > displayNameMaxLength) {
    errors.displayName = `公開表示名は${displayNameMaxLength}文字以内で入力してください。`;
  } else if (/[\r\n]/.test(name)) errors.displayName = "公開表示名に改行は使えません。";
  for (const field of optionalFieldOrder) {
    const limit = optionalFieldLimits[field];
    if (countCharacters(form.optionalFields[field].value) > limit) {
      errors[field] = `${optionalFieldLabels[field]}は${limit}文字以内で入力してください。`;
    }
  }
  return errors;
}

/** 422 の項目エラーの表示文言。 */
const fieldErrorMessages: Record<SavedFieldError, string> = {
  displayName: "公開表示名を確認してください。",
  bio: "自己紹介を確認してください。",
  occupation: "職種を確認してください。",
  interests: "関心分野を確認してください。",
};

export function ProfileEditor({ profile }: { profile: MyProfile }) {
  const router = useRouter();
  const formId = useId();
  const [form, setForm] = useState<FormState>(() => initialState(profile));
  const [version, setVersion] = useState(profile.version);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [saving, setSaving] = useState(false);
  /** 応答を受け取れなかった送信。同じ内容で送り直すときは同じ再送キーを使い、二重に保存しない。 */
  const pending = useRef<{ body: string; key: string } | null>(null);

  function updateField(field: FieldName, change: Partial<OptionalFieldState>) {
    setForm((current) => ({
      ...current,
      optionalFields: { ...current.optionalFields, [field]: { ...current.optionalFields[field], ...change } },
    }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length) {
      setNotice({ kind: "error", message: "入力内容を確認してください。" });
      return;
    }

    const body = JSON.stringify({
      expectedVersion: version,
      displayName: form.displayName.trim(),
      searchOptIn: form.searchOptIn,
      optionalFields: Object.fromEntries(optionalFieldOrder.map((field) => [field, form.optionalFields[field]])),
    });
    const key = pending.current?.body === body ? pending.current.key : crypto.randomUUID();
    pending.current = { body, key };
    setSaving(true);
    setNotice(null);
    try {
      let outcome: SaveOutcome;
      try {
        const response = await fetch("/api/v1/me/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "Idempotency-Key": key },
          body,
        });
        outcome = saveOutcome(response.status, await response.json().catch(() => null));
      } catch {
        // 送信できたか分からない（通信の途中切断を含む）。
        outcome = { kind: "unconfirmed" };
      }

      // 保存されたか確認できない間は、同じ内容なら同じ再送キーで送り直せるように送信内容を保つ。
      if (outcome.kind !== "unconfirmed") pending.current = null;
      switch (outcome.kind) {
        case "saved":
          setVersion(outcome.version);
          setNotice({
            kind: "success",
            message: outcome.state === "hidden"
              ? "プロフィールを保存しました。再公開の申請として審査されます。"
              : "プロフィールを保存しました。",
          });
          // 共通ナビの表示名と審査状況を最新にする。入力中の内容はこの画面の状態として保つ。
          router.refresh();
          break;
        case "unconfirmed":
          setNotice({ kind: "error", message: unconfirmedMessage });
          break;
        case "conflict":
          setNotice({ kind: "error", message: conflictMessage, reload: true });
          break;
        case "invalid":
          setErrors(Object.fromEntries(outcome.fields.map((field) => [field, fieldErrorMessages[field]])));
          setNotice({ kind: "error", message: "入力内容を確認してください。" });
          break;
        case "unauthorized":
          setNotice({ kind: "error", message: "ログイン状態を確認できませんでした。再読み込みしてください。", reload: true });
          break;
        case "failed":
          setNotice({ kind: "error", message: failureMessage });
          break;
      }
    } finally {
      setSaving(false);
    }
  }

  const describedBy = (field: string, ...ids: Array<string | false>) =>
    [...ids, errors[field as keyof FieldErrors] ? `${formId}-${field}-error` : false].filter(Boolean).join(" ") || undefined;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>マイプロフィール</h1>
        <p className={styles.lead}>公開表示名と、ほかの利用者に見せる項目を設定します。</p>
      </header>

      <ProfileStatus profile={profile} headingId={`${formId}-state`} />

      <section className={styles.card} aria-labelledby={`${formId}-affiliation`}>
        <h2 id={`${formId}-affiliation`} className={styles.sectionTitle}>所属</h2>
        <p className={styles.help}>所属・学科・年度は学校が管理しています。この画面では変更できません。</p>
        <dl className={styles.details}>
          <div>
            <dt>所属</dt>
            <dd>
              {baseRoleLabels[profile.baseRole]}
              {profile.isGraduating ? <span className={styles.badgeInfo}>卒業予定</span> : null}
            </dd>
          </div>
          <div>
            <dt>学科</dt>
            <dd>{profile.fields.department ?? "未設定"}</dd>
          </div>
          <div>
            <dt>入学年度</dt>
            <dd>{profile.fields.entryYear ?? "未設定"}</dd>
          </div>
          <div>
            <dt>卒業年度</dt>
            <dd>{profile.fields.graduationYear ?? "未設定"}</dd>
          </div>
        </dl>
      </section>

      <form className={styles.card} onSubmit={onSubmit} noValidate aria-labelledby={`${formId}-form`}>
        <h2 id={`${formId}-form`} className={styles.sectionTitle}>公開情報の編集</h2>
        {notice?.kind === "error" ? (
          <div className={styles.formError} role="alert">
            <p>{notice.message}</p>
            {notice.reload ? (
              <button type="button" className={styles.secondaryButton} onClick={() => window.location.reload()}>
                最新の内容を読み込む
              </button>
            ) : null}
          </div>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${formId}-displayName`}>
            公開表示名<span className={styles.required}>必須</span>
          </label>
          <input
            id={`${formId}-displayName`}
            className={styles.input}
            value={form.displayName}
            onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))}
            aria-invalid={errors.displayName ? true : undefined}
            aria-describedby={describedBy("displayName", `${formId}-displayName-help`)}
            autoComplete="nickname"
          />
          <p id={`${formId}-displayName-help`} className={styles.help}>
            ほかの利用者に常に表示されます。{displayNameMaxLength}文字以内（{countCharacters(form.displayName.trim())}文字）
          </p>
          {errors.displayName ? (
            <p id={`${formId}-displayName-error`} className={styles.fieldError}>{errors.displayName}</p>
          ) : null}
        </div>

        {optionalFieldOrder.map((field) => {
          const inputId = `${formId}-${field}`;
          const state = form.optionalFields[field];
          const limit = optionalFieldLimits[field];
          return (
            <fieldset key={field} className={styles.fieldGroup}>
              <legend className={styles.label}>{optionalFieldLabels[field]}<span className={styles.optional}>任意</span></legend>
              <label className={styles.visuallyHidden} htmlFor={inputId}>{optionalFieldLabels[field]}の内容</label>
              {field === "bio" ? (
                <textarea
                  id={inputId}
                  className={`${styles.input} ${styles.textarea}`}
                  value={state.value}
                  rows={5}
                  onChange={(event) => updateField(field, { value: event.target.value })}
                  aria-invalid={errors[field] ? true : undefined}
                  aria-describedby={describedBy(field, `${inputId}-count`)}
                />
              ) : (
                <input
                  id={inputId}
                  className={styles.input}
                  value={state.value}
                  onChange={(event) => updateField(field, { value: event.target.value })}
                  aria-invalid={errors[field] ? true : undefined}
                  aria-describedby={describedBy(field, `${inputId}-count`)}
                />
              )}
              <p id={`${inputId}-count`} className={styles.help}>{limit}文字以内（{countCharacters(state.value)}文字）</p>
              {errors[field] ? <p id={`${inputId}-error`} className={styles.fieldError}>{errors[field]}</p> : null}
              <div className={styles.visibility} role="radiogroup" aria-label={`${optionalFieldLabels[field]}の公開範囲`}>
                <span className={styles.visibilityLabel} aria-hidden="true">公開範囲</span>
                {(["members", "self"] as const).map((option) => (
                  <label key={option} className={styles.radio}>
                    <input
                      type="radio"
                      name={`${inputId}-visibility`}
                      value={option}
                      checked={state.visibility === option}
                      onChange={() => updateField(field, { visibility: option })}
                    />
                    {visibilityLabels[option]}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}

        <div className={styles.field}>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={form.searchOptIn}
              onChange={(event) => setForm((current) => ({ ...current, searchOptIn: event.target.checked }))}
              aria-describedby={`${formId}-search-help`}
            />
            卒業生検索に掲載する
          </label>
          <p id={`${formId}-search-help`} className={styles.help}>
            掲載されるのは、プロフィールが公開中の卒業生と卒業予定の在校生です。公開範囲が「自分だけ」の項目は検索に使われません。
          </p>
        </div>

        <div className={styles.actions}>
          <button type="submit" className={styles.primaryButton} disabled={saving}>
            {saving ? "保存中…" : "保存する"}
          </button>
          <p className={styles.status} role="status" aria-live="polite">
            {notice?.kind === "success" ? notice.message : ""}
          </p>
        </div>
      </form>
    </div>
  );
}
