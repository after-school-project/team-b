import "server-only";
import { ApiError } from "@/api/response";
import type { db } from "./client";

/**
 * 画面（Server Component）の読み取りで起きた想定外の失敗。
 *
 * Next.js は描画中の例外をそのままサーバーログに出す。DBの例外は SQL と引数（セッショントークンや入力値）を含むため、
 * 元の例外は `cause` にも残さず、種類と呼び出し元だけを持つこの例外に置き換える。業務APIは `createApiResponse` で同じ扱いにしている。
 */
export class ScreenReadError extends Error {
  constructor(reason: unknown) {
    super(`画面の表示に必要な処理に失敗しました。（${failureCode(reason)}）`);
    this.name = "ScreenReadError";
    const frames = errorChain(reason).map(stackFrames).find((found) => found.length > 0) ?? [];
    this.stack = [`${this.name}: ${this.message}`, ...frames].join("\n");
  }
}

/** 例外と、その cause。Drizzle は PostgreSQL の例外を、Better Auth は Drizzle の例外を cause に持つ。 */
function errorChain(reason: unknown): Error[] {
  const chain: Error[] = [];
  for (let error = reason; error instanceof Error && !chain.includes(error); error = error.cause) chain.push(error);
  return chain;
}

/** ログに出してよい失敗の種類。SQLSTATE・接続エラーのコード、なければ例外の種類名。 */
function failureCode(reason: unknown): string {
  for (const error of errorChain(reason)) {
    const code = "code" in error ? error.code : undefined;
    if (typeof code === "string" && /^(?:[0-9A-Z]{5}|E[A-Z_]{2,30})$/.test(code)) return code;
  }
  return reason instanceof Error && /^[A-Za-z]{1,40}$/.test(reason.name) ? reason.name : "UNKNOWN";
}

/** 例外のスタックから、メッセージ（SQL・引数を含み得る）を除いた呼び出し元の行だけを取り出す。 */
function stackFrames(error: Error): string[] {
  if (typeof error.stack !== "string") return [];
  const start = error.stack.indexOf(error.message);
  // メッセージの範囲が分からなければ、呼び出し元の行と区別できないため何も残さない。
  if (error.message === "" || start < 0) return [];
  return error.stack.slice(start + error.message.length).split("\n").filter((line) => /^\s+at /.test(line));
}

/**
 * 画面の読み取りを実行し、想定外の失敗を `ScreenReadError` に置き換える。
 * `ApiError`（見つからない・入力の誤りなど、画面が扱う結果）はそのまま投げる。
 * Next.js の `redirect`・`notFound` は例外で動くため、`run` の中では呼ばない。
 */
export async function withSafeScreenErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ScreenReadError(error);
  }
}

/**
 * 画面からDBを読む。`src/app` の画面は `@/db/client` を直接読み込まず、必ずこの関数を使う（ESLint で確認する）。
 * DBクライアントは描画時に読み込む（ビルド時にDB接続情報を必要としない）。
 */
export async function readForScreen<T>(read: (database: typeof db) => Promise<T>): Promise<T> {
  return withSafeScreenErrors(async () => read((await import("./client")).db));
}
