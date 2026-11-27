import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createAnswer, createAnswers, createQuestions, removeQuestions } from "./database";
import { canonicalOrigin, signIn } from "./session";

/**
 * 解決状態の変更（QA-02、API-QA-12）と自分のQ&A投稿の一覧（GE-05、API-QA-13）を実セッションで確認する。#9 ⑥。
 * 準備手順は docs/development/quality-and-poc.md の「ホストでのE2E」を参照する。seed のパスワードを記録に残さないため、
 * トレースなどを無効にする。notifications.spec.ts が poc_a001 宛ての通知件数を数えるため、poc_a001 には通知を送らない。
 */
test.use({ trace: "off", screenshot: "off", video: "off" });

let marker: string;
test.beforeEach(() => {
  marker = `e2e-my-questions-${randomUUID()}`;
});
test.afterEach(() => removeQuestions(marker));

/** 更新の要求に、本番ビルドが受け付ける正規オリジンを付けて送る。 */
async function allowMutations(page: Page, baseURL: string) {
  const origin = canonicalOrigin ?? new URL(baseURL).origin;
  await page.context().route(/\/api\/v1\/questions\/[^/?]+\/resolution$/, async (route) => {
    await route.fulfill({ response: await route.fetch({ headers: { ...await route.request().allHeaders(), origin } }) });
  });
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("AC-11 モバイルでキーボードを使って、質問者本人が解決状態を何度でも切り替えられる", async ({ page, baseURL }) => {
  const [questionId] = await createQuestions(marker, [{ title: "解決を切り替える質問" }]);
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, baseURL!, "poc_s001");
  await allowMutations(page, baseURL!);
  await page.goto(`/questions/${questionId}`);

  const header = page.getByRole("article").filter({ has: page.getByRole("heading", { level: 1, name: "解決を切り替える質問" }) });
  await expect(header.getByText("未解決", { exact: true })).toBeVisible();
  const resolve = page.getByRole("button", { name: "解決済みにする" });
  await resolve.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "解決済みにしました。" })).toBeVisible();
  await expect(header.getByText("解決済み", { exact: true })).toBeVisible();
  const reopen = page.getByRole("button", { name: "未解決に戻す" });
  await expect(reopen).toBeFocused();
  // 解決済みの質問にも回答できる。
  await expect(page.getByRole("textbox", { name: "回答の本文" })).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "未解決に戻しました。" })).toBeVisible();
  await expect(header.getByText("未解決", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "解決済みにする" })).toBeFocused();
  await page.reload();
  await expect(header.getByText("未解決", { exact: true })).toBeVisible();
  expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);
});

test("質問者以外には解決状態の変更を出さない", async ({ page, baseURL }) => {
  const [questionId] = await createQuestions(marker, [{ title: "他人の質問" }]);
  await signIn(page, baseURL!, "poc_s002");
  await page.goto(`/questions/${questionId}`);
  await expect(page.getByRole("heading", { level: 1, name: "他人の質問" })).toBeVisible();
  await expect(page.getByRole("button", { name: /解決済みにする|未解決に戻す/ })).toHaveCount(0);
});

test("AC-12 モバイルで自分の投稿を種類で絞り込み、残存する回答から QA-02 へ移動できる", async ({ page, baseURL }) => {
  const [ownQuestion, deletedQuestion] = await createQuestions(marker, [
    { title: `一覧に出る質問 ${marker}` },
    { title: `削除した質問 ${marker}`, deleted: true },
  ]);
  const answerId = await createAnswer(deletedQuestion, "poc_s001", `残っている回答 ${marker}`);
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, baseURL!, "poc_s001");
  // 本人メニュー（モバイルではメニューの中）から開ける。
  await page.goto("/");
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await page.getByRole("navigation", { name: "マイメニュー" }).getByRole("link", { name: "自分のQ&A" }).click();
  await expect(page).toHaveURL(/\/me\/questions$/);

  await expect(page.getByRole("heading", { level: 1, name: "自分のQ&A" })).toBeVisible();
  const kinds = page.getByRole("navigation", { name: "投稿の種類" });
  await expect(kinds.getByRole("link", { name: "すべて" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: `一覧に出る質問 ${marker}` })).toHaveAttribute("href", `/questions/${ownQuestion}`);
  const remaining = page.getByRole("listitem").filter({ hasText: `残っている回答 ${marker}` });
  await expect(remaining).toContainText("質問は削除済み");
  await expect(remaining.getByRole("link", { name: "削除された質問への回答" })).toBeVisible();
  await expect(page.getByText(`削除した質問 ${marker}`)).toHaveCount(0);

  // 種類の絞り込みはキーボードで操作できる。
  const answers = kinds.getByRole("link", { name: "回答", exact: true });
  await answers.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/me\/questions\?kind=answer$/);
  await expect(kinds.getByRole("link", { name: "回答", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: `一覧に出る質問 ${marker}` })).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);

  await page.getByRole("listitem").filter({ hasText: `残っている回答 ${marker}` })
    .getByRole("link", { name: "削除された質問への回答" }).click();
  await expect(page).toHaveURL(new RegExp(`/questions/${deletedQuestion}#response-${answerId}$`));
  await expect(page.getByText("この質問は削除されました。")).toBeVisible();
  await expect(page.locator(`#response-${answerId}`)).toContainText(`残っている回答 ${marker}`);
});

test("最初に表示する50件より後の自分の回答へのリンクでも、その回答まで移動する", async ({ page, baseURL }) => {
  const [questionId] = await createQuestions(marker, [{ title: `回答の多い質問 ${marker}` }]);
  await createAnswers(questionId, "poc_s002", Array.from({ length: 51 }, (_, index) => `先の回答${index + 1}`));
  const answerId = await createAnswer(questionId, "poc_s001", `52件目の自分の回答 ${marker}`);
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/me/questions?kind=answer");
  await page.getByRole("listitem").filter({ hasText: `52件目の自分の回答 ${marker}` })
    .getByRole("link", { name: `「回答の多い質問 ${marker}」への回答` }).click();
  await expect(page).toHaveURL(new RegExp(`/questions/${questionId}#response-${answerId}$`));
  const target = page.locator(`#response-${answerId}`);
  await expect(target).toContainText(`52件目の自分の回答 ${marker}`);
  await expect(target).toBeFocused();
  await expect(target).toBeInViewport();
});

test("解決状態の変更後、画面の再取得が終わるまでは次の変更を送らない", async ({ page, baseURL }) => {
  const [questionId] = await createQuestions(marker, [{ title: "続けて切り替える質問" }]);
  await signIn(page, baseURL!, "poc_s001");
  await allowMutations(page, baseURL!);
  await page.goto(`/questions/${questionId}`);
  // 画面の再取得（RSC の要求）を、合図があるまで止める。
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let heldRefresh = false;
  await page.route(`**/questions/${questionId}*`, async (route) => {
    const headers = route.request().headers();
    if (route.request().method() !== "GET" || !headers.rsc) return route.fallback();
    heldRefresh = true;
    await held;
    await route.fallback();
  });
  const patches: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().endsWith("/resolution")) patches.push(request.postData() ?? "");
  });

  const toggle = page.getByRole("button", { name: "解決済みにする" });
  await toggle.click();
  await expect(page.getByRole("status").filter({ hasText: "解決済みにしました。" })).toBeVisible();
  await expect.poll(() => heldRefresh).toBe(true);
  // 再取得中は変更中のまま。押しても送信しない。
  const busy = page.getByRole("button", { name: "変更中…" });
  await expect(busy).toHaveAttribute("aria-disabled", "true");
  await expect(busy).toBeFocused();
  // Playwright の click は aria-disabled の要素が押せるようになるまで待つため、イベントを直接送って押下を試す。
  await busy.dispatchEvent("click");
  await page.keyboard.press("Enter");
  expect(patches).toHaveLength(1);

  release();
  await expect(page.getByRole("button", { name: "未解決に戻す" })).toBeVisible();
  await page.getByRole("button", { name: "未解決に戻す" }).click();
  await expect(page.getByRole("status").filter({ hasText: "未解決に戻しました。" })).toBeVisible();
  // 古い版で送っていれば、版の競合の案内が出る。
  await expect(page.getByText("質問が更新されています。")).toHaveCount(0);
  expect(patches.map((body) => JSON.parse(body))).toEqual([
    { expectedVersion: 1, resolution: "resolved" }, { expectedVersion: 2, resolution: "open" },
  ]);
});
