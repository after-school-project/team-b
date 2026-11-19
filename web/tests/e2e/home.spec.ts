import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * 実セッションでホームへ入れることを確認する。モックせず、本番ビルドの認証・利用状態API・ホームの認可を通す。
 * seed のパスワードは `E2E_ACCOUNTS_FILE`（既定は `web/.seed/accounts.json`）から読み、出力しない。
 */
const accountsFile = resolve(process.env.E2E_ACCOUNTS_FILE ?? ".seed/accounts.json");

function passwordFor(username: string): string {
  if (!existsSync(accountsFile)) {
    throw new Error(`seed の認証情報が見つかりません。E2E_ACCOUNTS_FILE に accounts.json のパスを設定してください：${accountsFile}`);
  }
  const password = (JSON.parse(readFileSync(accountsFile, "utf8")) as Record<string, string>)[username];
  if (!password) throw new Error(`accounts.json に ${username} の認証情報がありません。`);
  return password;
}

const canonicalOrigin = process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL).origin : undefined;

test.beforeEach(async ({ page, baseURL }) => {
  if (!canonicalOrigin || canonicalOrigin === new URL(baseURL!).origin) return;
  // 本番ビルドは HTTPS の正規オリジンからの要求だけを受け付ける。ローカルの HTTP 実行では、
  // TLS 終端の代わりに同一サイトの API 要求の Origin を正規オリジンへ置き換える。
  // ブラウザーは Origin の上書きを送らないため、テスト側から要求して応答（Cookie を含む）を返す。
  await page.route("**/api/**", async (route) => {
    const headers = route.request().headers();
    if (!headers.origin) return route.continue();
    headers.origin = canonicalOrigin;
    return route.fulfill({ response: await route.fetch({ headers }) });
  });
});

test("利用中の利用者はログイン後にホームを表示し、再読み込み後も表示を保つ", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/login");

  await page.getByLabel("ログインID").fill("poc_s001");
  await page.getByLabel("パスワード").fill(passwordFor("poc_s001"));
  await page.getByRole("button", { name: "ログイン", exact: true }).click();

  await expect(page).toHaveURL("/");
  await expect(page.getByText("ただいま準備中です。")).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL("/");
  await expect(page.getByText("ただいま準備中です。")).toBeVisible();
});

test("戻り先付きでログインすると、クエリーを保ったままホームを表示する", async ({ page }) => {
  await page.goto("/?tab=home");
  await expect(page).toHaveURL("/login?returnTo=%2F%3Ftab%3Dhome");

  await page.getByLabel("ログインID").fill("poc_a001");
  await page.getByLabel("パスワード").fill(passwordFor("poc_a001"));
  await page.getByRole("button", { name: "ログイン", exact: true }).click();

  await expect(page).toHaveURL("/?tab=home");
  await expect(page.getByText("ただいま準備中です。")).toBeVisible();
});

test("停止中の利用者はログインしてもホームを表示せず、ログイン画面の停止案内に留まる", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("ログインID").fill("poc_suspended");
  await page.getByLabel("パスワード").fill(passwordFor("poc_suspended"));
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page.getByRole("button", { name: "ログアウト" })).toBeVisible();

  await page.goto("/");
  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("button", { name: "ログアウト" })).toBeVisible();
  await expect(page.getByText("ただいま準備中です。")).toHaveCount(0);
});
