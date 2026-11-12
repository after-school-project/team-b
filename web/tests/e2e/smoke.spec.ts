import { expect, test } from "@playwright/test";

test("本番ビルドで日本語の初期ページを表示できる", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("After School Project");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("After School Project");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
});

test("存在しないページは404を返す", async ({ request }) => {
  const response = await request.get("/not-a-real-route");
  expect(response.status()).toBe(404);
});
