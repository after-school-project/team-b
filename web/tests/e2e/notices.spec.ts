import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { canonicalOrigin, signIn } from "./session";

test.use({ trace: "off", screenshot: "off", video: "off" });

async function signInForNotices(page: Page, baseURL: string, user: string) {
  await signIn(page, baseURL, user);
  const origin = canonicalOrigin ?? new URL(baseURL).origin;
  await page.route(/\/api\/v1\/(notices|me\/notice-requests)(\/|$)/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const headers = { ...await route.request().allHeaders(), origin };
    await route.fulfill({ response: await route.fetch({ headers }) });
  });
}

test("本人一覧から詳細へ移り、審査中の申請だけに取り下げ操作を表示する", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_a001");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/me/notices?state=pending&sort=updated_desc");
  await expect(page.getByRole("heading", { level: 1, name: "自分のお知らせ" })).toBeVisible();
  await page.getByRole("link", { name: /卒業生とのキャリア相談/ }).click();

  await expect(page.getByRole("heading", { level: 1, name: "卒業生とのキャリア相談" })).toBeVisible();
  await expect(page.getByRole("form", { name: "自分のお知らせの絞り込み" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.getByRole("link", { name: "申請履歴へ" }).click();
  await expect(page).toHaveURL(/#notice-history$/);
  await page.getByRole("link", { name: /新規申請.*承認済み/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "新規申請" })).toBeVisible();
  await expect(page.getByRole("button", { name: "申請を取り下げる" })).toHaveCount(0);

  const breadcrumbs = page.getByRole("navigation", { name: "パンくず" });
  await breadcrumbs.getByRole("link", { name: "卒業生とのキャリア相談" }).click();
  const pending = page.getByRole("link", { name: /編集申請.*審査中/ });
  await pending.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "編集申請" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "卒業生とのキャリア相談（詳細追記）" })).toBeVisible();
  await expect(page.getByRole("button", { name: "申請を取り下げる" })).toBeVisible();
  await breadcrumbs.getByRole("link", { name: "自分のお知らせ" }).click();
  await expect(page).toHaveURL("/me/notices?state=pending&sort=updated_desc");
});

test("卒業生の新規投稿から申請詳細を開き、対象の内容を確認してから取り下げられる", async ({ page, baseURL }) => {
  await signInForNotices(page, baseURL!, "poc_a001");
  const title = "新規お知らせ " + randomUUID();

  await page.goto("/notices/new");
  await page.getByRole("textbox", { name: "タイトル" }).fill(title);
  await page.getByRole("textbox", { name: "本文" }).fill("申請内容を確認するためのお知らせです。");
  await page.getByRole("button", { name: "審査に提出する" }).click();
  await expect(page).toHaveURL(/\/me\/notices\?notice=[\da-f-]+&request=[\da-f-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "新規申請" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();

  await page.getByRole("button", { name: "申請を取り下げる" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(title)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "キャンセル" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "申請を取り下げる" }).click();
  await dialog.getByRole("button", { name: "取り下げる", exact: true }).click();
  await expect(page.getByText("取り下げ済み", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "申請を取り下げる" })).toHaveCount(0);
});

test("学校職員の即時公開編集から公開詳細を開く", async ({ page, baseURL }) => {
  await signInForNotices(page, baseURL!, "poc_staff");
  const title = "職員のお知らせ " + randomUUID();

  await page.goto("/notices/new");
  await page.getByRole("textbox", { name: "タイトル" }).fill(title);
  await page.getByRole("textbox", { name: "本文" }).fill("すぐに公開されるお知らせです。");
  await page.getByRole("button", { name: "公開する", exact: true }).click();
  await expect(page).toHaveURL(/\/notices\/[\da-f-]+$/);
  const publicPath = new URL(page.url()).pathname;
  const id = publicPath.split("/").at(-1)!;

  await page.goto(`/me/notices/${id}/edit`);
  await page.getByRole("textbox", { name: "タイトル" }).fill(title + " 更新");
  await page.getByRole("button", { name: "公開する", exact: true }).click();
  await expect(page).toHaveURL(publicPath);
  await expect(page.getByRole("heading", { level: 1, name: title + " 更新" })).toBeVisible();
});
