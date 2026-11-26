import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createNotifications, removeNotifications } from "./database";
import { canonicalOrigin, signIn } from "./session";

/**
 * 通知一覧（GE-06）とヘッダーの未読件数を実セッションで確認する（#17 ②）。
 * 準備手順は docs/development/quality-and-poc.md の「ホストでのE2E」を参照する。seed のパスワードを記録に残さないため、
 * トレースなどを無効にする。
 *
 * 通知は seed で通知を持たない卒業生（poc_a001）宛てに作り、テストごとに消す。同じ利用者の通知を作るテストが
 * 並行すると件数が変わるため、このファイルのテストは順に実行する。
 */
test.use({ trace: "off", screenshot: "off", video: "off" });
test.describe.configure({ mode: "serial" });

const user = "poc_a001";
const headerLink = (page: Page) => page.getByRole("banner").getByRole("link", { name: /^通知/ });
const list = (page: Page) => page.getByRole("region", { name: /通知/ }).getByRole("listitem");

/**
 * 本番ビルドは正規オリジン（HTTPS）からの更新だけを受け付ける。ローカルのHTTP実行では、既読の操作を
 * Cookie を含む元の要求ヘッダーのまま、正規オリジンで Playwright から送り直す（my-profile.spec.ts と同じ扱い）。
 */
async function signInWithCanonicalOrigin(page: Page, baseURL: string, username: string) {
  await signIn(page, baseURL, username);
  const origin = canonicalOrigin ?? new URL(baseURL).origin;
  await page.route("**/api/v1/notifications/*/read", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ response: await route.fetch({ headers: { ...await route.request().allHeaders(), origin } }) });
  });
}

let marker: string;
test.beforeEach(() => {
  marker = `e2e-${randomUUID()}`;
});
test.afterEach(() => removeNotifications(marker));

test("AC-03 ヘッダーから一覧を開いても既読にならず、キーボードで既読にすると未読件数が減る", async ({ page, baseURL }) => {
  await createNotifications(user, marker, [
    { message: "新しい通知です。" },
    { message: "プロフィールが管理者により非表示になりました。\n理由：確認のため" },
    { message: "既読の通知です。", read: true },
  ]);
  await signInWithCanonicalOrigin(page, baseURL!, user);
  await page.goto("/");
  await expect(headerLink(page)).toHaveAccessibleName("通知 （未読2件）");
  await headerLink(page).click();
  await expect(page).toHaveURL("/notifications");
  await expect(page.getByRole("heading", { level: 1, name: "通知" })).toBeVisible();
  await expect(headerLink(page)).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 2, name: "通知 3件" })).toBeVisible();

  // 新しい順に並び、未読・既読をラベルで示す。理由は改行を保って表示する。
  const items = list(page);
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("未読");
  await expect(items.nth(0)).toContainText("新しい通知です。");
  await expect(items.nth(1)).toContainText("理由：確認のため");
  await expect(items.nth(2)).toContainText("既読");
  await expect(items.nth(2).getByRole("button", { name: "既読にする" })).toHaveCount(0);

  // 開いただけ・再読み込みしただけでは既読にならない。
  await page.reload();
  await expect(headerLink(page)).toHaveAccessibleName("通知 （未読2件）");
  await expect(page.getByRole("button", { name: "既読にする" })).toHaveCount(2);

  const button = items.nth(0).getByRole("button", { name: "既読にする" });
  await expect(button).toHaveAccessibleDescription("新しい通知です。");
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "通知を既読にしました。" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "通知 3件" })).toBeFocused();
  await expect(headerLink(page)).toHaveAccessibleName("通知 （未読1件）");
  await expect(items.nth(0).getByText("既読", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "既読にする" })).toHaveCount(1);

  // 再読み込みしても既読のまま。
  await page.reload();
  await expect(headerLink(page)).toHaveAccessibleName("通知 （未読1件）");
  await expect(list(page).nth(0).getByText("既読", { exact: true })).toBeVisible();
});

test("未読のみに絞り込め、既読にした通知は絞り込み後の一覧から外れる", async ({ page, baseURL }) => {
  await createNotifications(user, marker, [
    { message: "未読の通知A" }, { message: "既読の通知B", read: true }, { message: "未読の通知C" },
  ]);
  await signInWithCanonicalOrigin(page, baseURL!, user);
  await page.goto("/notifications");
  const filter = page.getByRole("navigation", { name: "表示する通知" });
  await expect(filter.getByRole("link", { name: "すべて" })).toHaveAttribute("aria-current", "page");
  await filter.getByRole("link", { name: "未読のみ" }).click();
  await expect(page).toHaveURL("/notifications?state=unread");
  await expect(filter.getByRole("link", { name: "未読のみ" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 2, name: "未読の通知 2件" })).toBeVisible();
  await expect(list(page)).toHaveText([/未読の通知A/, /未読の通知C/]);

  await list(page).filter({ hasText: "未読の通知A" }).getByRole("button", { name: "既読にする" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "未読の通知 1件" })).toBeFocused();
  await expect(list(page)).toHaveText([/未読の通知C/]);
  await list(page).getByRole("button", { name: "既読にする" }).click();
  await expect(page.getByText("未読の通知はありません。")).toBeVisible();
  await expect(headerLink(page)).toHaveAccessibleName("通知");
});

test("スマートフォンの幅でも横にはみ出さず、既読にできる", async ({ page, baseURL }) => {
  await createNotifications(user, marker, [
    { message: `とても長い理由の通知です。\n理由：${"確認のため".repeat(40)}` },
  ]);
  await page.setViewportSize({ width: 375, height: 812 });
  await signInWithCanonicalOrigin(page, baseURL!, user);
  await page.goto("/notifications");
  await expect(headerLink(page)).toBeVisible();
  const button = list(page).getByRole("button", { name: "既読にする" });
  await expect(button).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const box = await button.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await button.click();
  // 「既読にする」の文字に一致させず、既読の確定（案内とボタンの消去、ヘッダーの件数）を待つ。
  await expect(page.getByRole("status").filter({ hasText: "通知を既読にしました。" })).toBeVisible();
  await expect(list(page).getByText("既読", { exact: true })).toBeVisible();
  await expect(list(page).getByRole("button", { name: "既読にする" })).toHaveCount(0);
  await expect(headerLink(page)).toHaveAccessibleName("通知");
});

test("AC-04 停止中の利用者は通知一覧を開けず、通知の内容を表示しない", async ({ page, baseURL }) => {
  await createNotifications("poc_suspended", marker, [{ message: "停止中の利用者宛ての通知" }]);
  await signIn(page, baseURL!, "poc_suspended");
  await page.goto("/notifications");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText("停止中の利用者宛ての通知")).toHaveCount(0);
  const response = await page.request.get("/api/v1/notifications/unread-count");
  expect(response.status()).toBe(403);
});
