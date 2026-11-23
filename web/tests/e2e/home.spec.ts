import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * 実セッションでホームへ入れることを確認する。モックせず、本番ビルドの認証・利用状態API・ホームの認可を通す。
 * 準備手順は docs/development/quality-and-poc.md の「ホストでのE2E」を参照する。
 *
 * seed のパスワードはトレース・スクリーンショット・エラーメッセージ・失敗時のページスナップショットに残さない。
 * そのため画面の入力欄には入力せず、ブラウザーと Cookie を共有する要求コンテキストからサインインし、
 * トレースなどの記録をこのファイルでは無効にする。画面での入力と送信は login.spec.ts で確認する。
 */
test.use({ trace: "off", screenshot: "off", video: "off" });

const accountsFile = resolve(process.env.E2E_ACCOUNTS_FILE ?? ".seed/accounts.json");
const canonicalOrigin = process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL).origin : undefined;

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
async function signIn(page: Page, baseURL: string, username: string) {
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

test("利用中の利用者は実セッションでホームを表示し、再読み込み後も表示を保つ", async ({ page, baseURL }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/login");

  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/");
  await expect(page).toHaveURL("/");
  await expect(page.getByText("ただいま準備中です。")).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL("/");
  await expect(page.getByText("ただいま準備中です。")).toBeVisible();
});

test("ログイン画面は有効なセッションを戻り先へ送り、クエリーを保ったままホームを表示する", async ({ page, baseURL }) => {
  await page.goto("/?tab=home");
  await expect(page).toHaveURL("/login?returnTo=%2F%3Ftab%3Dhome");

  await signIn(page, baseURL!, "poc_a001");
  await page.reload();
  await expect(page).toHaveURL("/?tab=home");
  await expect(page.getByText("ただいま準備中です。")).toBeVisible();
});

test("ホームに共通レイアウトを表示し、本人メニューに自分の公開表示名を出す。一般利用者には管理導線を出さない", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "ホーム" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主要メニュー" }).getByRole("link", { name: "ホーム" }))
    .toHaveAttribute("aria-current", "page");
  // 未実装の画面への導線はリンクにしない。
  await expect(page.getByRole("link", { name: /Q&A/ })).toHaveCount(0);

  const accountButton = page.getByRole("button", { name: "マイメニュー" });
  await accountButton.click();
  await expect(accountButton).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText(/^ログイン中\s*はる$/).filter({ visible: true })).toHaveCount(1);
  await expect(page.getByText("管理エリアへ")).toHaveCount(0);
});

test("学校管理者には管理導線を表示する（管理エリアの実装前は準備中）", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_school");
  await page.goto("/");
  await expect(page.getByText("管理エリアへ")).toBeVisible();
  await expect(page.getByRole("link", { name: /管理エリアへ/ })).toHaveCount(0);
});

test("モバイル幅でもキーボードだけでメニューを開閉し、主要導線と管理導線を使える", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, baseURL!, "poc_s_mgr");
  await page.goto("/");

  const menuButton = page.getByRole("button", { name: "メニュー", exact: true });
  await expect(menuButton).toBeVisible();
  await expect(page.getByRole("link", { name: "ホーム" })).toBeHidden();

  await menuButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "閉じる" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: "ホーム" })).toBeVisible();
  await expect(page.getByText("管理エリアへ")).toBeVisible();
  await expect(page.getByText(/^ログイン中\s*在校生アプリ管理者$/).filter({ visible: true })).toHaveCount(1);

  // 開いたメニュー内のリンクへ Tab で移動でき、Escape で閉じてボタンへ戻る。
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "ホーム" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
  await expect(menuButton).toBeFocused();
});

test("画面の高さが低いモバイルでも、開いたメニュー内だけをスクロールし、閉じるボタンを表示したまま全項目を確認できる", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 500 });
  await signIn(page, baseURL!, "poc_school");
  await page.goto("/");

  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  const closeButton = page.getByRole("button", { name: "閉じる" });
  await expect(closeButton).toBeInViewport();
  const header = await page.locator("header").boundingBox();
  expect(header!.height).toBeLessThanOrEqual(500);

  // メニューの最後の項目（管理導線）までメニュー内でスクロールしても、閉じるボタンは画面内に残る。
  const adminItem = page.getByText("管理エリアへ");
  await adminItem.scrollIntoViewIfNeeded();
  await expect(adminItem).toBeInViewport();
  await expect(closeButton).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await closeButton.click();
  await expect(page.getByRole("heading", { level: 1, name: "ホーム" })).toBeInViewport();
});

test("停止中の利用者はホームを表示せず、ログイン画面の停止案内に留まる", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_suspended");
  await page.goto("/");
  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("button", { name: "ログアウト" })).toBeVisible();
  await expect(page.getByText("ただいま準備中です。")).toHaveCount(0);
});
