import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { userIdOf } from "./database";
import { canonicalOrigin, signIn } from "./session";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("Issue #16 モバイルで利用者検索から停止・解除・監査ログまでキーボードで操作できる", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, baseURL!, "poc_school");
  const userId = await userIdOf("poc_s002");
  const userApi = `/api/v1/admin/users/${encodeURIComponent(userId)}`;
  const origin = canonicalOrigin ?? new URL(baseURL!).origin;
  await page.route("**/api/v1/admin/users/*/suspension", async (route) => {
    const response = await route.fetch({ headers: { ...await route.request().allHeaders(), origin } });
    await route.fulfill({ response });
  });

  try {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "管理エリア", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "未対応の通報" })).toHaveAttribute("href", "/admin/reports");
    await page.getByRole("link", { name: "ユーザー管理", exact: true }).click();
    const search = page.getByRole("searchbox", { name: "公開表示名・ユーザーID" });
    await search.fill(userId);
    await search.press("Enter");
    const user = page.locator(`a[href="/admin/users/${encodeURIComponent(userId)}"]`);
    await user.focus();
    await page.keyboard.press("Enter");

    const showIdentity = page.getByRole("button", { name: "本人確認情報を照会する" });
    await showIdentity.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("認証用メール", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "本人確認情報を閉じる" }).click();
    await expect(page.getByText("認証用メール", { exact: true })).toHaveCount(0);

    const publicField = page.getByRole("textbox", { name: /本人向け理由/ });
    const internalField = page.getByRole("textbox", { name: /内部理由/ });
    const suspendButton = page.getByRole("button", { name: "アカウントを停止する", exact: true });
    await suspendButton.focus();
    await page.keyboard.press("Enter");
    await expect(publicField).toBeFocused();
    await expect(publicField).toHaveAttribute("aria-invalid", "true");
    await publicField.fill("モバイルで停止を確認します。");
    await internalField.fill("モバイル検証用の内部理由です。");
    await suspendButton.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "キャンセル" })).toBeFocused();
    expect((await dialog.boundingBox())?.width).toBeLessThan(375);
    await page.keyboard.press("Escape");
    await expect(suspendButton).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "アカウントを停止しました。" })).toBeFocused();
    await expect(page.getByText("停止中", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

    await publicField.fill("モバイルで停止の解除を確認します。");
    await internalField.fill("モバイル検証用の解除の内部理由です。");
    const resume = "アカウントの停止を解除する";
    await page.getByRole("button", { name: resume, exact: true }).press("Enter");
    await dialog.getByRole("button", { name: resume, exact: true }).click();
    await expect(page.getByText("利用中", { exact: true })).toBeVisible();
    await page.goto("/admin/audit-logs");
    await page.getByRole("link", { name: /アカウントを停止/ }).first().press("Enter");
    await expect(page.getByRole("heading", { name: "操作の詳細" })).toBeVisible();
    await expect(page.getByText("モバイルで停止を確認します。")).toBeVisible();
    await expect(page.getByText("モバイル検証用の内部理由です。")).toHaveCount(0);
  } finally {
    const response = await page.request.get(userApi);
    if (response.ok()) {
      const { data } = await response.json();
      if (data.accountStatus === "suspended") {
        const restored = await page.request.post(`${userApi}/suspension`, {
          headers: { Origin: origin, "Idempotency-Key": randomUUID() },
          data: { expectedVersion: data.version, suspended: false, publicReason: "検証を終了しました。", internalReason: "E2E後の状態復元" },
        });
        expect(restored.ok()).toBe(true);
      }
    }
  }
});

test("アプリ管理者の管理ホームと対象者詳細には学校専用の操作を表示しない", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s_mgr");
  await page.goto("/admin");
  await expect(page.getByRole("link", { name: "ユーザー管理" })).toBeVisible();
  await expect(page.getByRole("link", { name: "監査ログ" })).toHaveCount(0);
  await page.goto("/admin/audit-logs");
  await expect(page.getByRole("heading", { name: "操作履歴" })).toHaveCount(0);
  await page.goto(`/admin/users/${encodeURIComponent(await userIdOf("poc_a_mgr"))}`);
  await expect(page.getByRole("heading", { name: "ユーザー管理" })).toBeVisible();
  await expect(page.getByRole("button", { name: "本人確認情報を照会する" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "アカウントを停止する" })).toHaveCount(0);
});
