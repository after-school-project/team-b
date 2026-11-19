"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

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

function validate(username: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  if (!username) errors.username = "ログインIDを入力してください";
  else if (!/^[a-z0-9_]{3,30}$/.test(username)) {
    errors.username = "ログインIDは小文字英数字とアンダースコアの3〜30文字で入力してください。";
  }

  if (!password) errors.password = "パスワードを入力してください";
  else if ([...password].length < 12 || [...password].length > 128) {
    errors.password = "パスワードは12〜128文字で入力してください。";
  }

  return errors;
}

export default function LoginForm({ returnTo }: LoginFormProps) {
  const router = useRouter();
  const submitting = useRef(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
  const [publicReason, setPublicReason] = useState("");
  const [view, setView] = useState<"form" | "checking" | "not-ready" | "suspended">("form");
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

      setPassword("");
      const meResponse = await fetch("/api/v1/me");
      if (meResponse.status === 401) {
        setView("form");
        setFormError(authenticationError);
        return;
      }

      const me = parseMeResponse(await meResponse.json());
      if (meResponse.status === 403 && me.error?.code === "ACCOUNT_NOT_READY") {
        setView("not-ready");
        return;
      }
      if (!meResponse.ok) {
        setView("form");
        setFormError(processingError);
        return;
      }

      if (me.data?.access === "suspended" && typeof me.data.publicReason === "string" && me.data.publicReason.trim()) {
        setPublicReason(me.data.publicReason);
        setView("suspended");
        return;
      }
      if (me.data?.access === "active") {
        router.replace(returnTo);
        return;
      }

      setView("form");
      setFormError(processingError);
    } catch {
      setView("form");
      setFormError(processingError);
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

  return (
    <main>
      <section aria-labelledby="login-title">
        <h1 id="login-title">ログイン</h1>

        {view === "not-ready" ? (
          <div role="status">
            このアカウントは利用準備中です。
          </div>
        ) : view === "suspended" ? (
          <div>
            <h2>このアカウントは利用停止中です。</h2>
            <p>{publicReason}</p>
            {formError && <p role="alert">{formError}</p>}
            <button type="button" onClick={signOut} disabled={loggingOut}>
              {loggingOut ? "ログアウト中..." : "ログアウト"}
            </button>
          </div>
        ) : (
          <form onSubmit={submit} noValidate>
            <div>
              <label htmlFor="username">ログインID</label>
              <input
                autoComplete="username"
                id="username"
                name="username"
                type="text"
                value={username}
                aria-invalid={Boolean(fieldErrors.username)}
                aria-describedby={fieldErrors.username ? "username-error" : undefined}
                disabled={view === "checking"}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setFieldErrors((current) => ({ ...current, username: undefined }));
                }}
              />
              {fieldErrors.username && (
                <p id="username-error">{fieldErrors.username}</p>
              )}
            </div>

            <div>
              <label htmlFor="password">パスワード</label>
              <input
                autoComplete="current-password"
                id="password"
                name="password"
                type="password"
                value={password}
                aria-invalid={Boolean(fieldErrors.password)}
                aria-describedby={fieldErrors.password ? "password-error" : undefined}
                disabled={view === "checking"}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setFieldErrors((current) => ({ ...current, password: undefined }));
                }}
              />
              {fieldErrors.password && (
                <p id="password-error">{fieldErrors.password}</p>
              )}
            </div>

            {formError && <p role="alert">{formError}</p>}

            <button type="submit" disabled={view === "checking"}>
              {view === "checking" ? "確認中..." : "ログイン"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
