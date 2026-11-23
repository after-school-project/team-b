import { expect, test, type Page } from "@playwright/test";
import { canonicalOrigin, signIn } from "./session";

/**
 * マイプロフィール（GE-02）を実セッションで確認する（#8 ①②）。準備手順は docs/development/quality-and-poc.md の
 * 「ホストでのE2E」を参照する。seed のパスワードを記録に残さないため、トレースなどを無効にする。
 */
test.use({ trace: "off", screenshot: "off", video: "off" });

/**
 * 本番ビルドは正規オリジン（HTTPS）からの更新だけを受け付ける。ローカルのHTTP実行では、ブラウザーが送る Origin を
 * 正規オリジンに置き換える（TLS終端の背後からの要求に相当。session.ts のサインインと同じ扱い）。
 * ブラウザーは Origin の書き換えを受け付けないため、Cookie を含む元の要求ヘッダーのまま Playwright から送り直し、
 * その応答をブラウザーへ返す。
 */
async function useCanonicalOrigin(page: Page, baseURL: string) {
  const origin = canonicalOrigin ?? new URL(baseURL).origin;
  await page.route("**/api/v1/me/profile", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const headers = { ...await route.request().allHeaders(), origin };
    await route.fulfill({ response: await route.fetch({ headers }) });
  });
}

test("未認証でマイプロフィールを開くと、戻り先付きでログイン画面に移る", async ({ page }) => {
  await page.goto("/me/profile");
  await expect(page).toHaveURL("/login?returnTo=%2Fme%2Fprofile");
});

test("本人メニューからマイプロフィールを開き、公開状態・所属・任意項目と公開範囲を確認できる", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_a001");
  await page.goto("/");
  await page.getByRole("button", { name: "マイメニュー" }).click();
  await page.getByRole("link", { name: "マイプロフィール" }).filter({ visible: true }).click();

  await expect(page).toHaveURL("/me/profile");
  await expect(page.getByRole("heading", { level: 1, name: "マイプロフィール" })).toBeVisible();
  await expect(page.getByText("公開中", { exact: true })).toBeVisible();
  await expect(page.getByText("卒業生", { exact: true })).toBeVisible();
  // 所属・学科・年度は表示だけで、入力欄にしない。
  await expect(page.getByRole("textbox", { name: /学科|入学年度|卒業年度/ })).toHaveCount(0);
  await expect(page.getByRole("radiogroup", { name: "関心分野の公開範囲" }).getByRole("radio", { name: "自分だけ" }))
    .toBeChecked();
});

test("キーボードだけで任意項目と公開範囲を変更して保存し、再読み込み後も保たれる", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s002");
  await useCanonicalOrigin(page, baseURL!);
  await page.goto("/me/profile");

  const occupation = `E2E確認 ${Date.now()}`;
  const input = page.getByRole("textbox", { name: "職種の内容" });
  await input.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(occupation);
  await page.keyboard.press("Tab"); // 文字数の案内を経て、公開範囲の選択へ
  await page.getByRole("radiogroup", { name: "職種の公開範囲" }).getByRole("radio", { name: "ログインした利用者に公開" }).focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "保存する" }).focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("status").filter({ hasText: "プロフィールを保存しました。" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "職種の内容" })).toHaveValue(occupation);
  await expect(page.getByRole("radiogroup", { name: "職種の公開範囲" }).getByRole("radio", { name: "ログインした利用者に公開" }))
    .toBeChecked();
});

test("入力エラーは項目の近くに表示し、入力した内容を保つ", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s002");
  await useCanonicalOrigin(page, baseURL!);
  await page.goto("/me/profile");

  const name = page.getByRole("textbox", { name: /公開表示名/ });
  await name.fill("あ".repeat(51));
  await page.getByRole("button", { name: "保存する" }).click();
  // Next.js のページ遷移の読み上げ（role="alert"）と区別するため、フォーム内のエラーを確認する。
  await expect(page.getByRole("form", { name: "公開情報の編集" }).getByRole("alert")).toContainText("入力内容を確認してください。");
  await expect(page.getByText("公開表示名は50文字以内で入力してください。")).toBeVisible();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveValue("あ".repeat(51));
});

test("非表示中の利用者には、非表示の案内と再公開申請の審査状況を表示する", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_hidden");
  await page.goto("/me/profile");
  await expect(page.getByText("非表示", { exact: true })).toBeVisible();
  await expect(page.getByText("内容を修正して保存すると、再公開の申請として管理者が審査します。")).toBeVisible();
  await expect(page.getByText("承認待ち", { exact: true })).toBeVisible();
});

test("モバイル幅でも横スクロールなしで、すべての項目と保存ボタンを使える", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, baseURL!, "poc_a001");
  await page.goto("/me/profile");

  await expect(page.getByRole("heading", { level: 1, name: "マイプロフィール" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const label of ["自己紹介の内容", "職種の内容", "関心分野の内容"]) {
    await expect(page.getByRole("textbox", { name: label })).toBeVisible();
  }
  const save = page.getByRole("button", { name: "保存する" });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  const box = await save.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});
