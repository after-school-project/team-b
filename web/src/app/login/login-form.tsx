"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
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

type View = "form" | "checking" | "not-ready" | "suspended" | "logout-required";

/** `GET /api/v1/me` の結果から判定した利用状態。 */
type Access =
  | { kind: "unauthenticated" }
  | { kind: "active" }
  | { kind: "not-ready" }
  | { kind: "suspended"; publicReason: string }
  | { kind: "unknown" };

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

async function fetchAccess(signal?: AbortSignal): Promise<Access> {
  const response = await fetch("/api/v1/me", { signal, cache: "no-store" });
  if (response.status === 401) return { kind: "unauthenticated" };

  const me = await readMeResponse(response);
  if (response.status === 403 && me.error?.code === "ACCOUNT_NOT_READY") return { kind: "not-ready" };
  if (response.ok && me.data?.access === "active") return { kind: "active" };
  if (
    response.ok &&
    me.data?.access === "suspended" &&
    typeof me.data.publicReason === "string" &&
    me.data.publicReason.trim()
  ) {
    return { kind: "suspended", publicReason: me.data.publicReason };
  }
  // 5xx・想定外の形式など、利用状態を確認できない。
  return { kind: "unknown" };
}

/** セッションを失効させる。失効を確認できた（2xx）ときだけ true を返す。 */
async function requestSignOut(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return response.ok;
  } catch {
    return false;
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
  const sessionCheck = useRef<AbortController | null>(null);

  // 入口の表示時に既存セッションの利用状態を確認する（停止案内を再読み込みしてもログアウト導線を残す）。
  useEffect(() => {
    const controller = new AbortController();
    sessionCheck.current = controller;

    fetchAccess(controller.signal)
      .then((access) => {
        if (controller.signal.aborted) return;
        if (access.kind === "active") {
          router.replace(returnTo);
        } else if (access.kind === "not-ready") {
          setView("not-ready");
        } else if (access.kind === "suspended") {
          setPublicReason(access.publicReason);
          setView("suspended");
        }
        // 未認証・確認できない場合はログインフォームのまま。ログインすると新しいセッションに置き換わる。
      })
      .catch(() => {
        // 通信できない場合もログインフォームのまま。
      })
      .finally(() => {
        if (sessionCheck.current === controller) sessionCheck.current = null;
      });

    return () => controller.abort();
  }, [returnTo, router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const errors = validate(username, password);
    setFieldErrors(errors);
    setFormError("");
    if (Object.keys(errors).length > 0) return;

    submitting.current = true;
    // 入口表示時の確認結果で、これから行うログインの結果を上書きしない。
    sessionCheck.current?.abort();
    setView("checking");
    let signedIn = false;

    async function failAfterSignIn() {
      if (await requestSignOut()) {
        setView("form");
        setFormError(processingError);
        return;
      }
      // セッションを失効できたか確認できないため、ログアウトの再試行を残す。
      setView("logout-required");
      setFormError(logoutError);
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
      const access = await fetchAccess();
      if (access.kind === "unauthenticated") {
        setView("form");
        setFormError(authenticationError);
        return;
      }
      if (access.kind === "not-ready") {
        setView("not-ready");
        return;
      }
      if (access.kind === "active") {
        router.replace(returnTo);
        return;
      }
      if (access.kind === "suspended") {
        setPublicReason(access.publicReason);
        setView("suspended");
        return;
      }

      // 利用状態を確認できない場合はセッションを残さない。
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
      if (!(await requestSignOut())) {
        setFormError(logoutError);
        return;
      }
      setUsername("");
      setPassword("");
      setPublicReason("");
      setView("form");
      router.replace("/login");
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
        ) : view === "logout-required" ? (
          accountNotice(
            "ログイン処理を完了できませんでした。",
            <p className={styles.reason}>ログアウトしてから、もう一度ログインしてください。</p>,
          )
        ) : (
          // method="post": JavaScript が動く前に送信されても、認証情報を URL に含めない。
          <form className={styles.form} method="post" onSubmit={submit} noValidate aria-labelledby="login-title">
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
