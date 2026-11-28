import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createAnswer, createQuestions, removeQuestionReports, removeQuestions, userIdOf } from "./database";
import { canonicalOrigin, signIn } from "./session";

test.use({ trace: "off", screenshot: "off", video: "off" });

async function useCanonicalOrigin(page: Page, baseURL: string, path: string) {
  const origin = canonicalOrigin ?? new URL(baseURL).origin;
  await page.route(path, async (route) => {
    if (route.request().method() === "GET") return route.continue();
    const response = await route.fetch({ headers: { ...await route.request().allHeaders(), origin } });
    await route.fulfill({ response });
  });
}

test("Issue #15 モバイル幅で通報の最終確認から案件対応・証拠閲覧まで操作できる", async ({ page, browser, baseURL }) => {
  const marker = `e2e-report-cases-${randomUUID()}`;
  const title = "通報フォームの検証用質問";
  const [questionId] = await createQuestions(marker, [{ title }]);
  const admin = await browser.newPage({ baseURL, viewport: { width: 375, height: 812 } });
  try {
    const answerId = await createAnswer(questionId, "poc_a001", "通報導線の検証用回答");
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, baseURL!, "poc_s002");
    await useCanonicalOrigin(page, baseURL!, "**/api/v1/reports");
    await page.goto(`/questions/${questionId}`);
    await expect(page.locator(`#response-${answerId}`).getByRole("button", { name: "回答を通報" })).toBeVisible();
    const trigger = page.getByRole("button", { name: "質問を通報" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    expect((await dialog.boundingBox())?.width).toBeLessThan(375);
    const reason = dialog.getByRole("combobox", { name: "通報理由（必須）" });
    await expect(reason).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(reason.locator("option")).toHaveCount(7);
    await reason.selectOption("other");
    const confirm = dialog.getByRole("button", { name: "送信前の確認へ" });
    const detail = dialog.getByRole("textbox", { name: "詳細（必須）" });
    await confirm.click();
    await expect(detail).toBeFocused();
    await expect(detail).toHaveAccessibleDescription(/その他を選ぶ場合は詳細を入力/);
    await detail.fill("あ".repeat(501));
    await confirm.click();
    await expect(detail).toHaveAccessibleDescription(/500文字以内で入力/);
    await detail.fill("通報受付の確認用です。");
    await confirm.click();
    await expect(dialog.getByRole("heading", { name: "通報内容の確認" })).toBeFocused();
    await expect(dialog.getByText(title, { exact: false })).toBeVisible();
    await dialog.getByRole("button", { name: "入力に戻る" }).click();
    await expect(detail).toHaveValue("通報受付の確認用です。");
    await confirm.click();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "入力に戻る" })).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("heading", { name: "通報を受け付けました" })).toBeFocused();
    await expect(dialog.getByRole("link")).toHaveCount(0);
    await dialog.getByRole("button", { name: "閉じる" }).click();
    await expect(trigger).toBeFocused();

    await page.goto(`/users/${encodeURIComponent(await userIdOf("poc_a001"))}`);
    await expect(page.getByRole("button", { name: "プロフィールを通報" })).toBeVisible();
    await expect(page.getByRole("button", { name: "アカウントを通報" })).toBeVisible();
    await page.goto(`/users/${encodeURIComponent(await userIdOf("poc_school"))}`);
    await expect(page.getByRole("button", { name: /を通報/ })).toHaveCount(0);

    await signIn(admin, baseURL!, "poc_school");
    await useCanonicalOrigin(admin, baseURL!, "**/api/v1/admin/report-cases/**");
    await useCanonicalOrigin(admin, baseURL!, "**/api/v1/admin/questions/**/visibility");
    await admin.goto("/");
    await admin.getByRole("button", { name: "メニュー", exact: true }).click();
    await admin.getByRole("link", { name: "管理エリアへ" }).click();
    await admin.getByRole("link", { name: "未対応の通報" }).click();
    await expect(admin.getByRole("heading", { name: "通報案件", exact: true })).toBeVisible();
    const status = admin.getByRole("combobox", { name: "対応状態" });
    await expect(status).toHaveValue("unhandled");
    await status.selectOption("all");
    await admin.getByRole("button", { name: "絞り込む" }).click();
    await expect(admin).toHaveURL(/[?&]status=all(?:&|$)/);
    await admin.getByRole("link", { name: `質問 · ${title}` }).click();
    await expect(admin.getByRole("heading", { name: "通報案件の詳細" })).toBeVisible();
    expect(await admin.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await expect(admin.getByText("通報受付の確認用です。", { exact: true })).toBeVisible();
    let patches = 0;
    admin.on("request", (request) => {
      if (request.method() === "PATCH" && new URL(request.url()).pathname.startsWith("/api/v1/admin/report-cases/")) patches++;
    });
    await admin.getByRole("button", { name: "状態・優先度を保存" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "変更はありません。" })).toBeVisible();
    expect(patches).toBe(0);
    await admin.getByRole("link", { name: /取得日時.*の証拠/ }).click();
    const snapshot = admin.locator("#evidence-content");
    await expect(snapshot.getByRole("heading", { name: title })).toBeVisible();

    await admin.getByRole("button", { name: "質問を非表示にする" }).click();
    const operation = admin.getByRole("dialog");
    await operation.getByRole("textbox", { name: "本人向け理由" }).fill("案件からの措置を検証します。");
    await operation.getByRole("button", { name: "非表示にする", exact: true }).click();
    await expect(admin.getByText("投稿を非表示", { exact: true })).toBeVisible();

    await admin.getByRole("textbox", { name: "対応メモ" }).fill("案件対応の確認用メモ");
    await admin.getByRole("button", { name: "対応メモを追加" }).click();
    await expect(admin.getByText("案件対応の確認用メモ", { exact: true })).toBeVisible();
    await admin.getByRole("button", { name: "対応済みにする", exact: true }).click();
    await operation.getByRole("button", { name: "対応済みにする", exact: true }).click();
    await expect(admin.getByText("対応済みの案件です。履歴と証拠を確認できます。")).toBeVisible();
    await expect(admin.getByRole("button", { name: "対応メモを追加" })).toHaveCount(0);
  } finally {
    await admin.close();
    await removeQuestionReports(questionId);
    await removeQuestions(marker);
  }
});

test("停止中は通報画面に入れず、プロフィール非表示中は通報フォームを利用できる", async ({ page, browser, baseURL }) => {
  const profilePath = `/users/${encodeURIComponent(await userIdOf("poc_a001"))}`;
  await signIn(page, baseURL!, "poc_suspended");
  await page.goto(profilePath);
  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("button", { name: /を通報/ })).toHaveCount(0);

  const hidden = await browser.newPage({ baseURL });
  try {
    await signIn(hidden, baseURL!, "poc_hidden");
    await hidden.goto(profilePath);
    await hidden.getByRole("button", { name: "プロフィールを通報" }).click();
    await expect(hidden.getByRole("dialog").getByRole("combobox", { name: /通報理由/ })).toBeFocused();
  } finally {
    await hidden.close();
  }
});
