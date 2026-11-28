import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createAnswer, createQuestions, removeQuestions } from "./database";
import { canonicalOrigin, signIn } from "./session";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("Issue #10 モバイルの Q&A 詳細で質問と回答を非表示・復元し、閲覧権限を反映する", async ({ page, browser, baseURL }) => {
  const marker = `e2e-qa-moderation-${randomUUID()}`;
  const title = "管理操作を確認する質問";
  const answer = "管理操作を確認する回答の本文";
  const [questionId] = await createQuestions(marker, [{ title }]);
  const visitor = await browser.newContext({ baseURL });
  try {
    const answerId = await createAnswer(questionId, "poc_a001", answer);
    const origin = canonicalOrigin ?? new URL(baseURL!).origin;
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, baseURL!, "poc_school");
    await page.route("**/api/v1/admin/**/visibility", async (route) => {
      const response = await route.fetch({ headers: { ...await route.request().allHeaders(), origin } });
      await route.fulfill({ response });
    });
    await page.goto(`/questions/${questionId}`);

    const hideQuestion = page.getByRole("button", { name: "質問を非表示にする" });
    await hideQuestion.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    const reason = dialog.getByRole("textbox", { name: "本人向け理由" });
    await expect(reason).toBeFocused();
    const box = await dialog.boundingBox();
    expect(box?.width).toBeLessThan(375);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(hideQuestion).toBeFocused();
    await page.keyboard.press("Enter");
    await dialog.getByRole("button", { name: "非表示にする", exact: true }).click();
    await expect(reason).toBeFocused();
    await expect(reason).toHaveAccessibleDescription(/本人向け理由を入力してください/);
    await reason.fill("投稿者に伝える非表示の理由");
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "キャンセル" })).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    const restoreQuestion = page.getByRole("button", { name: "質問を復元する" });
    await expect(restoreQuestion).toBeEnabled();
    await expect(restoreQuestion).toBeFocused();
    await expect(page.getByText("この質問には新しい回答・コメントを投稿できません。")).toBeVisible();

    const publicPage = await visitor.newPage();
    await signIn(publicPage, baseURL!, "poc_s002");
    await publicPage.goto(`/questions/${questionId}`);
    await expect(publicPage.getByRole("heading", { name: title })).toHaveCount(0);
    await expect(publicPage.getByText("この質問は現在表示できません。")).toBeVisible();
    await expect(publicPage.getByText(answer, { exact: true })).toBeVisible();
    await expect(publicPage.getByRole("button", { name: /非表示にする|復元する/ })).toHaveCount(0);

    const answerCard = page.locator(`#response-${answerId}`);
    await answerCard.getByRole("button", { name: "回答を非表示にする" }).click();
    await dialog.getByRole("textbox", { name: "本人向け理由" }).fill("回答の内容を確認するため");
    await dialog.getByRole("button", { name: "非表示にする", exact: true }).click();
    const restoreAnswer = answerCard.getByRole("button", { name: "回答を復元する" });
    await expect(restoreAnswer).toBeEnabled();
    await expect(answerCard.getByText("非表示", { exact: true })).toBeVisible();
    await publicPage.reload();
    await expect(publicPage.getByText(answer, { exact: true })).toHaveCount(0);
    await expect(publicPage.getByText("この回答は現在表示できません。")).toBeVisible();

    await restoreAnswer.click();
    await expect(dialog.getByRole("textbox", { name: "復元理由" })).toBeEmpty();
    await dialog.getByRole("button", { name: "復元する", exact: true }).click();
    await expect(answerCard.getByRole("button", { name: "回答を非表示にする" })).toBeEnabled();
    await restoreQuestion.click();
    await dialog.getByRole("button", { name: "復元する", exact: true }).click();
    await expect(hideQuestion).toBeEnabled();
    await publicPage.reload();
    await expect(publicPage.getByRole("heading", { name: title })).toBeVisible();
    await expect(publicPage.getByText(answer, { exact: true })).toBeVisible();
  } finally {
    await visitor.close();
    await removeQuestions(marker);
  }
});
