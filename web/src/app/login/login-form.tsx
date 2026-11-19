"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";

const authenticationError =
  "ログインできませんでした。ログインIDとパスワードを確認し、時間をおいてもう一度お試しください。";
const processingError = "ログイン処理を完了できませんでした。時間をおいてもう一度お試しください。";
const logoutError = "ログアウトできませんでした。時間をおいてもう一度お試しください。";

type LoginFormProps = {
  returnTo: string;
};

type FieldErrors = {
  username?: string;
  password?: string;
};

type View = "form" | "checking" | "not-ready" | "suspended";

type MeResponse = {
  data?: {
    access?: unknown;
    publicReason?: unknown;
  };
  error?: {
    code?: unknown;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMeResponse(value: unknown): MeResponse {
  if (!isRecord(value)) return {};

  const data = isRecord(value.data)
    ? { access: value.data.access, publicReason: value.data.publicReason }
    : undefined;
  const error = isRecord(value.error) ? { code: value.error.code } : undefined;
  return { data, error };
}

async function readMeResponse(response: Response): Promise<MeResponse> {
  try {
    return parseMeResponse(await response.json());
  } catch {
    return {};
  }
}

function validate(username: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  if (!username) errors.username = "ログインIDを入力してください";
  else if (!/^[a-z0-9_]{3,30}$/.test(username)) {
    errors.username = "ログインIDは小文字英数字とアンダースコアの3〜30文字で入力してください。";
  }

  // 認証サーバー（Better Auth）と同じく、文字数は String#length（UTF-16 単位）で数える。
  if (!password) errors.password = "パスワードを入力してください";
  else if (password.length < 12 || password.length > 128) {
    errors.password = "パスワードは12〜128文字で入力してください。";
  }

  return errors;
}

/** 認証後に利用状態を確認できなかった場合に、残ったセッションを失効させる。失敗しても画面の案内は変えない。 */
async function discardSession() {
  try {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    // セッションが残っても、業務APIと保護画面はサーバー側の認可で拒否される。
  }
}

export default function LoginForm({ returnTo }: LoginFormProps) {
  const router = useRouter();
  const submitting = useRef(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
  const [publicReason, setPublicReason] = useState("");
  const [view, setView] = useState<View>("form");
  const [loggingOut, setLoggingOut] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const errors = validate(username, password);
    setFieldErrors(errors);
    setFormError("");
    if (Object.keys(errors).length > 0) return;

    submitting.current = true;
    setView("checking");
    let signedIn = false;

    async function failAfterSignIn() {
      await discardSession();
      setView("form");
      setFormError(processingError);
    }

    try {
      const signInResponse = await fetch("/api/auth/sign-in/username", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (signInResponse.status === 401 || signInResponse.status === 429) {
        setView("form");
        setFormError(authenticationError);
        return;
      }
      if (!signInResponse.ok) {
        setView("form");
        setFormError(processingError);
        return;
      }

      signedIn = true;
      setPassword("");
      setPasswordVisible(false);
      const meResponse = await fetch("/api/v1/me");
      if (meResponse.status === 401) {
        setView("form");
        setFormError(authenticationError);
        return;
      }

      const me = await readMeResponse(meResponse);
      if (meResponse.status === 403 && me.error?.code === "ACCOUNT_NOT_READY") {
        setView("not-ready");
        return;
      }
      if (meResponse.ok && me.data?.access === "active") {
        router.replace(returnTo);
        return;
      }
      if (
        meResponse.ok &&
        me.data?.access === "suspended" &&
        typeof me.data.publicReason === "string" &&
        me.data.publicReason.trim()
      ) {
        setPublicReason(me.data.publicReason);
        setView("suspended");
        return;
      }

      // 5xx・想定外の形式など、利用状態を確認できない場合はセッションを残さない。
      await failAfterSignIn();
    } catch {
      if (signedIn) {
        await failAfterSignIn();
      } else {
        setView("form");
        setFormError(processingError);
      }
    } finally {
      submitting.current = false;
    }
  }

  async function signOut() {
    setLoggingOut(true);
    setFormError("");
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        setFormError(logoutError);
        return;
      }
      setUsername("");
      setPassword("");
      setPublicReason("");
      setView("form");
      router.replace("/login");
    } catch {
      setFormError(logoutError);
    } finally {
      setLoggingOut(false);
    }
  }

  function accountNotice(title: string, body?: ReactNode) {
    return (
      <section className={styles.notice} aria-labelledby="account-notice-title">
        <div role="status">
          <h2 id="account-notice-title" className={styles.noticeTitle}>
            {title}
          </h2>
        </div>
        {body}
        {formError && (
          <p className={styles.formError} role="alert">
            {formError}
          </p>
        )}
        <button className={styles.secondaryButton} type="button" onClick={signOut} disabled={loggingOut}>
          {loggingOut ? "ログアウト中..." : "ログアウト"}
        </button>
      </section>
    );
  }

  const fieldErrorCount = Object.values(fieldErrors).filter(Boolean).length;
  const checking = view === "checking";

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <header className={styles.brand}>
          <p className={styles.appName}>After School Project</p>
          <h1 id="login-title" className={styles.title}>
            ログイン
          </h1>
          <p className={styles.lead}>学校から配布されたログインIDでログインします。</p>
        </header>

        {view === "not-ready" ? (
          accountNotice("このアカウントは利用準備中です。")
        ) : view === "suspended" ? (
          accountNotice("このアカウントは利用停止中です。", <p className={styles.reason}>{publicReason}</p>)
        ) : (
          <form className={styles.form} onSubmit={submit} noValidate aria-labelledby="login-title">
            {fieldErrorCount > 1 && (
              <p className={styles.summary} role="alert">
                {fieldErrorCount}件の入力内容を確認してください。
              </p>
            )}

            <div className={styles.field}>
              <label className={styles.label} htmlFor="username">
                ログインID<span className={styles.required}>必須</span>
              </label>
              <input
                className={styles.input}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                id="username"
                name="username"
                type="text"
                value={username}
                aria-invalid={Boolean(fieldErrors.username)}
                aria-describedby={fieldErrors.username ? "username-error" : undefined}
                disabled={checking}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setFieldErrors((current) => ({ ...current, username: undefined }));
                }}
              />
              {fieldErrors.username && (
                <p className={styles.fieldError} id="username-error">
                  {fieldErrors.username}
                </p>
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="password">
                パスワード<span className={styles.required}>必須</span>
              </label>
              <div className={styles.passwordRow}>
                <input
                  className={styles.input}
                  autoComplete="current-password"
                  id="password"
                  name="password"
                  type={passwordVisible ? "text" : "password"}
                  value={password}
                  aria-invalid={Boolean(fieldErrors.password)}
                  aria-describedby={fieldErrors.password ? "password-error" : undefined}
                  disabled={checking}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setFieldErrors((current) => ({ ...current, password: undefined }));
                  }}
                />
                <button
                  className={styles.toggleButton}
                  type="button"
                  aria-controls="password"
                  disabled={checking}
                  onClick={() => setPasswordVisible((visible) => !visible)}
                >
                  {passwordVisible ? "非表示" : "表示"}
                </button>
              </div>
              {fieldErrors.password && (
                <p className={styles.fieldError} id="password-error">
                  {fieldErrors.password}
                </p>
              )}
            </div>

            {formError && (
              <p className={styles.formError} role="alert">
                {formError}
              </p>
            )}

            <button className={styles.primaryButton} type="submit" disabled={checking}>
              {checking ? "確認中..." : "ログイン"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
