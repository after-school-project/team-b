import { expect, test, type Page } from "@playwright/test";
import { routeFormSignIn, signIn } from "./session";

/**
 * 卒業生検索（GE-04）と公開プロフィール（GE-03）を実セッションで確認する（#8 ③④、#48 から移管した AC-03）。
 * 準備手順は docs/development/quality-and-poc.md の「ホストでのE2E」を参照する。seed のパスワードを記録に残さないため、
 * トレースなどを無効にする。
 */
test.use({ trace: "off", screenshot: "off", video: "off" });

/** 卒業生検索から、公開表示名のリンクで公開プロフィールを開き、そのパスを返す。 */
async function openProfileFromSearch(page: Page, displayName: string): Promise<string> {
  await page.goto(`/alumni?q=${encodeURIComponent(displayName)}`);
  await page.getByRole("link", { name: displayName, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: displayName })).toBeVisible();
  return new URL(page.url()).pathname;
}

test("#48 AC-03 未認証で可変パスの画面を開くと、戻り先付きでログイン画面に移り、ログイン後にその画面へ戻る", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  const path = await openProfileFromSearch(page, "あおい");
  expect(path).toMatch(/^\/users\/[A-Za-z0-9_-]+$/);

  await page.context().clearCookies();
  await page.goto(path);
  await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent(path)}`);

  // フォームを送信し、ログイン成功後の遷移で戻り先へ戻ることを確認する（再読み込みによる既存セッションの経路ではない）。
  await routeFormSignIn(page, baseURL!, "poc_s001");
  await page.getByLabel("ログインID").fill("poc_s001");
  await page.getByLabel("パスワード").fill("dummy-password-for-e2e");
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(path);
  await expect(page.getByRole("heading", { level: 1, name: "あおい" })).toBeVisible();
});

test("有効なセッションでログイン画面の戻り先を開くと、可変パスの画面へ移動する", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  const path = await openProfileFromSearch(page, "あおい");
  await page.goto(`/login?returnTo=${encodeURIComponent(path)}`);
  await expect(page).toHaveURL(path);
  await expect(page.getByRole("heading", { level: 1, name: "あおい" })).toBeVisible();
});

test("共通ナビから卒業生検索を開き、キーボードだけで検索してプロフィールを開ける", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/");
  await page.getByRole("navigation", { name: "主要メニュー" }).getByRole("link", { name: "卒業生検索" }).click();
  await expect(page).toHaveURL("/alumni");
  await expect(page.getByRole("heading", { level: 1, name: "卒業生検索" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主要メニュー" }).getByRole("link", { name: "卒業生検索" }))
    .toHaveAttribute("aria-current", "page");

  await page.getByRole("textbox", { name: "キーワード" }).focus();
  await page.keyboard.type("あおい");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/alumni\?q=/);
  await expect(page.getByRole("heading", { name: /検索結果/ })).toContainText("1件");

  const result = page.getByRole("link", { name: "あおい", exact: true });
  await result.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "あおい" })).toBeVisible();
  // 公開を許可された自己紹介は表示し、本人のみの関心分野は表示しない。
  await expect(page.getByText("開発用のサンプルプロフィールです。")).toBeVisible();
  await expect(page.getByText("関心分野")).toHaveCount(0);
});

test("本人が自分の公開プロフィールを開くと、ほかの利用者向けの表示と編集への導線を示す", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_a001");
  await openProfileFromSearch(page, "あおい");
  await expect(page.getByText("あなたのプロフィールです。ほかの利用者には、この内容が表示されます。")).toBeVisible();
  await page.getByRole("link", { name: "マイプロフィールを編集" }).click();
  await expect(page).toHaveURL("/me/profile");
});

test("該当者がいない検索と、形式の誤った年度を画面内で案内する", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/alumni?q=" + encodeURIComponent("該当者のいないキーワード"));
  await expect(page.getByRole("heading", { name: /検索結果/ })).toContainText("0件");
  await expect(page.getByText("条件に合う卒業生・卒業予定者はいません。")).toBeVisible();

  await page.goto("/alumni?graduationYear=26");
  await expect(page.getByRole("alert").filter({ hasText: "検索条件を確認してください。" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "卒業年度" })).toHaveValue("26");
});

const filterLabels = ["キーワード", "学科", "入学年度", "卒業年度"] as const;

async function fillFilters(page: Page) {
  await page.getByRole("textbox", { name: "キーワード" }).fill("みなと");
  await page.getByRole("textbox", { name: "学科" }).fill("未送信の学科");
  await page.getByRole("textbox", { name: "入学年度" }).fill("2024");
  await page.getByRole("textbox", { name: "卒業年度" }).fill("2025");
}

async function expectFiltersEmpty(page: Page) {
  for (const label of filterLabels) await expect(page.getByRole("textbox", { name: label })).toHaveValue("");
}

test("検索前でも「条件をクリア」で未送信の入力を消し、そのまま検索しても消した条件を送らない", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/alumni");
  await fillFilters(page);
  await page.getByRole("button", { name: "条件をクリア" }).click();
  await expectFiltersEmpty(page);

  await page.getByRole("button", { name: "検索する" }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/alumni" && url.searchParams.has("q"));
  expect([...new URL(page.url()).searchParams.values()].every((value) => value === "")).toBe(true);
  await expect(page.getByRole("heading", { name: /検索結果/ })).toContainText("2件");
});

test("検索後に「条件をクリア」をキーボードで押すと、適用済みと未送信の条件を両方消す", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/alumni?q=" + encodeURIComponent("あおい"));
  await expect(page.getByRole("heading", { name: /検索結果/ })).toContainText("1件");
  await fillFilters(page);
  await page.getByRole("button", { name: "条件をクリア" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: /検索結果/ })).toContainText("2件");
  await expectFiltersEmpty(page);
});

test("検索後に共通ナビから卒業生検索を開き直すと、入力欄を適用中の条件にそろえる", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/alumni?q=" + encodeURIComponent("あおい"));
  await fillFilters(page);
  await page.getByRole("navigation", { name: "主要メニュー" }).getByRole("link", { name: "卒業生検索" }).click();
  await expect(page.getByRole("heading", { name: /検索結果/ })).toContainText("2件");
  await expectFiltersEmpty(page);
});

test("存在しない利用者のプロフィールは見つからない表示にする", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  const response = await page.goto("/users/no-such-user");
  expect(response?.status()).toBe(404);
});

test("モバイル幅でも横スクロールなしで、検索条件と結果を使える", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/alumni");
  await expect(page.getByRole("heading", { level: 1, name: "卒業生検索" })).toBeVisible();
  for (const label of ["キーワード", "学科", "入学年度", "卒業年度"]) {
    await expect(page.getByRole("textbox", { name: label })).toBeVisible();
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const button = page.getByRole("button", { name: "検索する" });
  expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("link", { name: "あおい", exact: true })).toBeVisible();
});
