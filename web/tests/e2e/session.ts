import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";

/**
 * 実セッションを使うE2Eの共通処理。準備手順は docs/development/quality-and-poc.md の「ホストでのE2E」を参照する。
 *
 * seed のパスワードはトレース・スクリーンショット・エラーメッセージ・失敗時のページスナップショットに残さない。
 * そのため画面の入力欄には入力せず、ブラウザーと Cookie を共有する要求コンテキストからサインインする。
 * このモジュールを使うテストファイルでは、トレースなどの記録を無効にする。
 */

const accountsFile = resolve(process.env.E2E_ACCOUNTS_FILE ?? ".seed/accounts.json");
export const canonicalOrigin = process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL).origin : undefined;

function passwordFor(username: string): string {
  if (!existsSync(accountsFile)) {
    throw new Error(`seed の認証情報が見つかりません。E2E_ACCOUNTS_FILE に accounts.json のパスを設定してください：${accountsFile}`);
  }
  let accounts: unknown;
  try {
    accounts = JSON.parse(readFileSync(accountsFile, "utf8"));
  } catch {
    // 解析エラーの内容にはファイルの一部（秘密値）が含まれ得るため、元の例外を出さない。
    throw new Error(`seed の認証情報を読み取れません。E2E_ACCOUNTS_FILE が db:setup で生成した accounts.json を指しているか確認してください：${accountsFile}`);
  }
  const password = accounts && typeof accounts === "object" ? (accounts as Record<string, unknown>)[username] : undefined;
  if (typeof password !== "string" || !password) throw new Error(`accounts.json に ${username} の認証情報がありません。`);
  return password;
}

/**
 * ブラウザーのコンテキストに実セッションを作る。本番ビルドは HTTPS の正規オリジンからの要求だけを受け付けるため、
 * ローカルの HTTP 実行でも Origin には `BETTER_AUTH_URL` の値を送る（TLS 終端の背後からの要求に相当）。
 * 失敗時は状態コードだけを報告し、要求本文や応答本文を出さない。
 */
export async function signIn(page: Page, baseURL: string, username: string) {
  // 認証情報ファイルの不備は通信エラーと区別して報告する（秘密値は含めない）。
  const password = passwordFor(username);
  let status: number;
  try {
    const response = await page.request.post("/api/auth/sign-in/username", {
      headers: { Origin: canonicalOrigin ?? new URL(baseURL).origin },
      data: { username, password },
      failOnStatusCode: false,
    });
    status = response.status();
  } catch {
    throw new Error(`${username} のサインイン要求を送信できませんでした。`);
  }
  if (status !== 200) throw new Error(`${username} でサインインできませんでした（HTTP ${status}）。`);
}
