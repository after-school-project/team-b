import { expect, test } from "@playwright/test";

test("本番ビルドで日本語のログイン画面を表示できる", async ({ page }) => {
  const response = await page.goto("/login");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("ログイン | After School Project");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
});

test("未認証でホームを開くと、個人データを返さずにログイン画面へ移動する", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/login");
  await expect(page.getByLabel("ログインID")).toBeVisible();
  await expect(page.getByText("ただいま準備中です。")).toHaveCount(0);
});

test("未認証でホームを開くと、許可した戻り先だけを付けてログイン画面へ移動する", async ({ page }) => {
  await page.goto("/?tab=home");
  await expect(page).toHaveURL("/login?returnTo=%2F%3Ftab%3Dhome");
});

test("存在しないページは404と日本語の案内を返し、キーボードでホームへの導線を使える", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const response = await page.goto("/not-a-real-route");
  expect(response?.status()).toBe(404);
  await expect(page).toHaveTitle("ページが見つかりません | After School Project");
  await expect(page.getByRole("heading", { level: 1, name: "ページが見つかりません" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "ホームへ戻る" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/login");
});
