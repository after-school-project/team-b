import "server-only";
import { ApiError } from "@/api/response";
import { describeFailure } from "@/api/safe-failure";
import type { db } from "./client";

/**
 * 画面（Server Component）の読み取りで起きた想定外の失敗。
 *
 * Next.js は描画中の例外をそのままサーバーログに出す。DBの例外は SQL と引数（セッショントークンや入力値）を含むため、
 * 元の例外は `cause` にも残さず、種類と呼び出し元だけを持つこの例外に置き換える。業務API・認証APIのログも同じ情報だけにしている。
 */
export class ScreenReadError extends Error {
  constructor(reason: unknown) {
    const { cause, at } = describeFailure(reason);
    super(`画面の表示に必要な処理に失敗しました。（${cause}）`);
    this.name = "ScreenReadError";
    this.stack = [`${this.name}: ${this.message}`, ...at.map((line) => `    ${line}`)].join("\n");
  }
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
