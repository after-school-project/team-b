import { randomUUID } from "node:crypto";

const errors = {
  BAD_REQUEST: [400, "リクエストの形式が正しくありません。"],
  INVALID_CURSOR: [400, "一覧を先頭から取得してください。"],
  AUTH_REQUIRED: [401, "ログインしてください。"],
  FORBIDDEN: [403, "この操作は許可されていません。"],
  ACCOUNT_NOT_READY: [403, "このアカウントは利用準備中です。"],
  ACCOUNT_SUSPENDED: [403, "このアカウントは利用停止中です。"],
  PROFILE_WRITE_RESTRICTED: [403, "プロフィールの公開状態により、この操作はできません。"],
  ORIGIN_NOT_ALLOWED: [403, "この送信元は許可されていません。"],
  NOT_FOUND: [404, "対象が見つかりません。"],
  METHOD_NOT_ALLOWED: [405, "このHTTPメソッドは利用できません。"],
  VERSION_CONFLICT: [409, "内容が更新されています。再読込して確認してください。"],
  STATE_CONFLICT: [409, "対象の状態が変わっています。再読込して確認してください。"],
  IDEMPOTENCY_KEY_REUSED: [409, "この再送キーは別の操作に使われています。"],
  CASE_CLOSED: [409, "この案件は対応済みです。"],
  ASSIGNEE_INELIGIBLE: [409, "この利用者には担当を割り当てられません。"],
  PAYLOAD_TOO_LARGE: [413, "本文は128 KiB以内で送信してください。"],
  UNSUPPORTED_MEDIA_TYPE: [415, "本文はUTF-8のJSONで送信してください。"],
  VALIDATION_FAILED: [422, "入力内容を確認してください。"],
  RATE_LIMITED: [429, "時間をおいて再試行してください。"],
  INTERNAL_ERROR: [500, "処理中にエラーが発生しました。"],
  TEMPORARILY_UNAVAILABLE: [503, "時間をおいて同じ内容で再試行してください。"],
} as const;

type ErrorCode = keyof typeof errors;
export type FieldError = { path: string; code: string; message: string };
export type SuccessStatus = 200 | 201;
export type PageInfo = {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
  totalCount: number;
};

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly options: { fields?: readonly FieldError[]; allow?: string; retryAfterSeconds?: number } = {},
  ) {
    super(errors[code][1]);
  }
}

export function rateLimited(retryAfterSeconds: number): ApiError {
  return new ApiError("RATE_LIMITED", { retryAfterSeconds });
}

const unavailableCodes = new Set([
  "55P03", "40P01", "40001", "57014", "53300", "57P01", "57P02", "57P03",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN",
]);

function temporarilyUnavailable(reason: unknown): boolean {
  const seen = new Set<Error>();
  // Drizzle wraps PostgreSQL failures in an Error with the driver error as its cause.
  for (let error = reason; error instanceof Error && !seen.has(error); error = error.cause) {
    seen.add(error);
    const code = "code" in error ? error.code : undefined;
    if (typeof code === "string" && (unavailableCodes.has(code) || /^08[A-Z0-9]{3}$/.test(code))) return true;
    if (error.message === "timeout exceeded when trying to connect" ||
      error.message === "Connection terminated unexpectedly") return true;
  }
  return false;
}

export function createApiResponse() {
  const requestId = randomUUID();
  const meta = () => ({ requestId, serverTime: new Date().toISOString() });

  function json(body: unknown, status: number, headers?: HeadersInit) {
    const responseHeaders = new Headers(headers);
    responseHeaders.set("Cache-Control", "private, no-store");
    return Response.json(body, { status, headers: responseHeaders });
  }

  return {
    success(data: unknown, options: { status?: SuccessStatus; page?: PageInfo; replayed?: true } = {}) {
      const { status = 200, ...extra } = options;
      return json({ data, meta: { ...extra, ...meta() } }, status);
    },
    failure(reason: unknown) {
      const error = reason instanceof ApiError ? reason :
        new ApiError(temporarilyUnavailable(reason) ? "TEMPORARILY_UNAVAILABLE" : "INTERNAL_ERROR");
      const [status, message] = errors[error.code];
      if (status >= 500) {
        // Error causes may contain SQL, parameters, or connection strings.
        console.error("業務APIの処理に失敗しました。", { requestId, code: error.code });
      }
      const fields = status < 500 ? (error.options.fields ?? []) : [];
      const headers = new Headers();
      if (status === 405 && error.options.allow !== undefined) headers.set("Allow", error.options.allow);
      if (status === 429 && error.options.retryAfterSeconds !== undefined) {
        headers.set("Retry-After", String(Math.max(1, Math.ceil(error.options.retryAfterSeconds))));
      }
      return json({ error: { code: error.code, message, fields }, meta: meta() }, status, headers);
    },
  };
}
