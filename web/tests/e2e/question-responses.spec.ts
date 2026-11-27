import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createAnswer, createQuestions, removeQuestions } from "./database";
import { canonicalOrigin, signIn } from "./session";

/**
 * 回答・コメント・返信のスレッド表示と投稿・編集（QA-02、#9 ③④、API-QA-07〜10）を実セッションで確認する。
 * 準備手順は docs/development/quality-and-poc.md の「ホストでのE2E」を参照する。seed のパスワードを記録に残さないため、
 * トレースなどを無効にする。
 *
 * notifications.spec.ts は poc_a001 宛ての通知件数を数えるため、このファイルの投稿では poc_a001 に通知が届かないようにする。
 */
test.use({ trace: "off", screenshot: "off", video: "off" });

let marker: string;
test.beforeEach(() => {
  marker = `e2e-response-${randomUUID()}`;
});
test.afterEach(() => removeQuestions(marker));

/** 更新の要求に、本番ビルドが受け付ける正規オリジンを付けて送る。 */
async function allowMutations(page: Page, baseURL: string) {
  const origin = canonicalOrigin ?? new URL(baseURL).origin;
  await page.context().route(/\/api\/v1\/(?:questions\/[^/?]+\/responses|responses\/[^/?]+)$/, async (route) => {
    if (route.request().method() === "GET") return route.continue();
    await route.fulfill({ response: await route.fetch({ headers: { ...await route.request().allHeaders(), origin } }) });
  });
}

test("AC-07・AC-08 モバイルでキーボードを使って回答・コメント・返信を投稿し、本人が編集できる", async ({ page, baseURL }) => {
  const [questionId] = await createQuestions(marker, [{ title: "回答を待つ質問" }]);
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, baseURL!, "poc_a001");
  await allowMutations(page, baseURL!);
  await page.goto(`/questions/${questionId}`);
  await expect(page.getByText("まだ回答・コメントはありません。")).toBeVisible();

  const answerBody = page.getByRole("textbox", { name: "回答の本文" });
  await answerBody.fill("<div>HTML</div>");
  await page.getByRole("button", { name: "投稿する" }).click();
  await expect(answerBody).toHaveAccessibleDescription(/HTMLのタグは使えません/);
  await answerBody.fill("**最初の回答**です");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "投稿する" })).toBeFocused();
  await page.keyboard.press("Enter");
  const answer = page.getByRole("article", { name: "あおいさんの回答" });
  await expect(answer).toBeFocused();
  await expect(answer.getByText("最初の回答", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "回答・コメント" }).getByRole("status")).toHaveText("回答を投稿しました。");
  await expect(answerBody).toHaveValue("");

  // 回答にはコメント、コメントには返信を付ける。開閉はキーボードで操作できる。
  const commentEntry = answer.getByRole("button", { name: "コメントする" });
  await commentEntry.focus();
  await page.keyboard.press("Enter");
  await expect(commentEntry).toHaveAttribute("aria-expanded", "true");
  await answer.getByRole("textbox", { name: "コメントの本文" }).fill("回答へのコメント");
  await answer.getByRole("button", { name: "投稿する" }).click();
  const comment = page.getByRole("article", { name: "あおいさんのコメント" });
  await expect(comment).toContainText("回答へのコメント");
  await comment.getByRole("button", { name: "返信する" }).click();
  await comment.getByRole("textbox", { name: "返信の本文" }).fill("コメントへの返信");
  await comment.getByRole("button", { name: "投稿する" }).click();
  await expect(page.getByRole("article", { name: "あおいさんの返信" })).toContainText("コメントへの返信");

  // 再読込しても、親子関係を保って表示する。
  await page.reload();
  const thread = page.getByRole("region", { name: "回答・コメント" });
  await expect(thread.getByRole("listitem").filter({ has: page.getByRole("article", { name: "あおいさんの回答" }) })
    .getByRole("article", { name: "あおいさんの返信" })).toBeVisible();

  const own = page.getByRole("article", { name: "あおいさんの回答" });
  await own.getByRole("button", { name: "回答を編集" }).click();
  const editBody = own.getByRole("textbox", { name: "回答の本文" });
  await expect(editBody).toHaveValue("**最初の回答**です");
  await editBody.fill("編集した回答");
  await own.getByRole("button", { name: "保存する" }).click();
  const edited = page.getByRole("article", { name: "あおいさんの回答" });
  await expect(edited).toContainText("編集した回答");
  await expect(edited).toContainText("（編集済み）");
  await expect(thread.getByRole("status")).toHaveText("回答を保存しました。");

  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(0);
});

test("AC-08 プロフィール非表示中の利用者には投稿の入口を出さず、理由を案内する", async ({ page, baseURL }) => {
  const [questionId] = await createQuestions(marker, [{ title: "非表示中に見る質問" }]);
  await createAnswer(questionId, "poc_a001", "既存の回答");
  await signIn(page, baseURL!, "poc_hidden");
  await page.goto(`/questions/${questionId}`);
  await expect(page.getByText("既存の回答")).toBeVisible();
  await expect(page.getByText("プロフィールが非表示のため、回答・コメント・返信を投稿できません。")).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /コメントする|返信する|編集/ })).toHaveCount(0);
});

test("AC-06 削除済みの質問では本文を出さず、残存する回答を表示して返信できる", async ({ page, baseURL }) => {
  const [questionId] = await createQuestions(marker, [{ title: "削除された質問", deleted: true }]);
  // notifications.spec.ts が poc_a001 の通知件数を数えるため、通知の宛先（残存回答の投稿者）を poc_a001 にしない。
  await createAnswer(questionId, "poc_s001", "残っている回答");
  await signIn(page, baseURL!, "poc_s002");
  await allowMutations(page, baseURL!);
  await page.goto(`/questions/${questionId}`);
  await expect(page.getByText("この質問は削除されました。")).toBeVisible();
  await expect(page.getByText("削除された質問")).toHaveCount(0);
  await expect(page.getByText("この質問には新しい回答・コメントを投稿できません。")).toBeVisible();
  const answer = page.getByRole("article", { name: "e2eの回答者名さんの回答" });
  await expect(answer).toContainText("残っている回答");
  await answer.getByRole("button", { name: "コメントする" }).click();
  await answer.getByRole("textbox", { name: "コメントの本文" }).fill("残存回答へのコメント");
  await answer.getByRole("button", { name: "投稿する" }).click();
  await expect(page.getByRole("article", { name: "みなとさんのコメント" })).toContainText("残存回答へのコメント");
});
