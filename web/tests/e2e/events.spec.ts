import { expect, test } from "@playwright/test";
import { signIn } from "./session";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("イベント一覧をモバイル幅でキーボード操作できる", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, baseURL!, "poc_s002");
  await page.goto("/");
  const menu = page.getByRole("button", { name: /^(メニュー|閉じる)$/ });
  await expect(async () => {
    if (await menu.getAttribute("aria-expanded") === "false") await menu.press("Enter");
    await expect(menu).toHaveAttribute("aria-expanded", "true", { timeout: 500 });
  }).toPass({ timeout: 10000 });
  const nav = page.getByRole("navigation", { name: "主要メニュー" }).getByRole("link", { name: "イベント", exact: true });
  await nav.press("Enter");
  await expect(page).toHaveURL("/events");

  const search = page.getByRole("textbox", { name: "キーワード" });
  await search.fill("交流会");
  await search.press("Tab");
  await expect(page.getByRole("combobox", { name: "開催状態" })).toBeFocused();
  await page.keyboard.press("Tab");
  const sort = page.getByRole("combobox", { name: "並び順" });
  await expect(sort).toBeFocused();
  await sort.selectOption("starts_asc");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "検索する" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/sort=starts_asc/);
  await expect(page.getByRole("heading", { name: "学校と卒業生の交流会" })).toBeVisible();
  await expect(page.getByRole("link", { name: "学校と卒業生の交流会" })).toHaveCount(0);
  await expect(page.getByText("在校生の制作もくもく会")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.getByRole("combobox", { name: "開催状態" }).selectOption("cancelled");
  await page.getByRole("button", { name: "検索する" }).press("Enter");
  await expect(page.getByText("条件に合うイベントはありません。")).toBeVisible();
});

test("未ログインの一覧アクセスは検索条件付きでログインへ戻す", async ({ page }) => {
  await page.goto("/events?state=ended");
  await expect(page).toHaveURL((url) => url.pathname === "/login" && url.searchParams.get("returnTo") === "/events?state=ended");
});

test("共通ナビからイベント一覧を開き直すと未送信の入力と絞り込みをリセットする", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s002");
  await page.goto("/events?state=cancelled");
  const keyword = page.getByRole("textbox", { name: "キーワード" });
  const state = page.getByRole("combobox", { name: "開催状態" });
  await expect(state).toHaveValue("cancelled");
  await expect(page.getByText("条件に合うイベントはありません。")).toBeVisible();
  await keyword.fill("未送信");
  await page.getByRole("navigation", { name: "主要メニュー" }).getByRole("link", { name: "イベント", exact: true }).click();
  await expect(page).toHaveURL("/events");
  await expect(page.getByRole("heading", { name: "学校と卒業生の交流会" })).toBeVisible();
  await expect(keyword).toHaveValue("");
  await expect(state).toHaveValue("all");
});

test("キーワードの文字数超過だけを入力欄に案内する", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s002");
  const keyword = page.getByRole("textbox", { name: "キーワード" });
  const lengthError = page.getByText("キーワードは100文字以内で入力してください。", { exact: true });
  for (const query of ["limit=0", "state=invalid", "q=" + "a".repeat(100) + "&limit=0"]) {
    await page.goto("/events?" + query);
    await expect(page.getByRole("alert")).toHaveText("検索条件を確認してください。");
    await expect(lengthError).toHaveCount(0);
  }
  const query = new URLSearchParams({ q: "あ".repeat(101) });
  await page.goto("/events?" + query);
  await expect(lengthError).toBeVisible();
  await expect(keyword).toHaveAttribute("aria-invalid", "true");
  await expect(keyword).toHaveAccessibleDescription("キーワードは100文字以内で入力してください。");
});
