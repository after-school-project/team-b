import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createAnswer, createAnswers, createQuestions, removeQuestions } from "./database";
import { canonicalOrigin, signIn } from "./session";

/**
 * 回答・コメント・返信のスレッド表示と投稿・編集・削除（QA-02、#9 ③④⑤、API-QA-06〜11）を実セッションで確認する。
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
  const mutations = /\/api\/v1\/(?:questions\/[^/?]+\/(?:responses|deletion)|responses\/[^/?]+(?:\/deletion)?)$/;
  await page.context().route(mutations, async (route) => {
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

test("投稿を保存すると、保存したフォームだけを閉じ、ほかのフォームの入力を残す", async ({ page, baseURL }) => {
  const [questionId] = await createQuestions(marker, [{ title: "フォームを複数開く質問" }]);
  await createAnswer(questionId, "poc_s001", "コメントを付ける回答");
  await signIn(page, baseURL!, "poc_s002");
  await allowMutations(page, baseURL!);
  await page.goto(`/questions/${questionId}`);

  await page.getByRole("button", { name: "質問にコメントする" }).click();
  const questionComment = page.getByRole("textbox", { name: "コメントの本文" }).last();
  await questionComment.fill("書きかけの質問へのコメント");
  await page.getByRole("textbox", { name: "回答の本文" }).fill("書きかけの回答");

  const answer = page.getByRole("article", { name: "e2eの回答者名さんの回答" });
  await answer.getByRole("button", { name: "コメントする" }).click();
  await answer.getByRole("textbox", { name: "コメントの本文" }).fill("回答へのコメント");
  await answer.getByRole("button", { name: "投稿する" }).click();
  await expect(page.getByRole("article", { name: "みなとさんのコメント" })).toContainText("回答へのコメント");
  await expect(answer.getByRole("textbox")).toHaveCount(0);

  await expect(questionComment).toHaveValue("書きかけの質問へのコメント");
  await expect(page.getByRole("textbox", { name: "回答の本文" })).toHaveValue("書きかけの回答");
});

test("AC-05 投稿の後に続きのページを読み込んでも、作成日時の順に表示する", async ({ page, baseURL }) => {
  const [questionId] = await createQuestions(marker, [{ title: "回答の多い質問" }]);
  // 最初のページは50件。51件目は続きのページに入る。
  await createAnswers(questionId, "poc_s001", Array.from({ length: 51 }, (_, index) => `既存の回答${index + 1}`));
  await signIn(page, baseURL!, "poc_s002");
  await allowMutations(page, baseURL!);
  await page.goto(`/questions/${questionId}`);
  await expect(page.getByText("既存の回答50", { exact: true })).toBeVisible();
  await expect(page.getByText("既存の回答51", { exact: true })).toHaveCount(0);

  await page.getByRole("textbox", { name: "回答の本文" }).fill("新しい回答");
  await page.getByRole("button", { name: "投稿する" }).click();
  await expect(page.getByText("新しい回答", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "さらに表示" }).click();
  await expect(page.getByText("既存の回答51", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "さらに表示" })).toHaveCount(0);

  const bodies = await page.getByRole("region", { name: "回答・コメント" }).getByRole("article").allInnerTexts();
  const order = bodies.map((text) => text.match(/既存の回答\d+|新しい回答/)?.[0]);
  expect(order.slice(-3)).toEqual(["既存の回答50", "既存の回答51", "新しい回答"]);
  expect(order).toHaveLength(52);
});

/**
 * 指定した要求のうち最初の1件の応答を、`release` を呼ぶまで止める。`received` は、止めた応答をサーバーから受け取ったときに
 * 解決する。2件目以降はほかの処理へ渡す。`times` で処理を1回に限ると、その処理が外れたときに、別の止めている要求も
 * 処理済みとして扱われるため、フラグで1件目だけを止める。
 */
async function holdResponse(page: Page, url: RegExp, method: string, origin?: string) {
  let release!: () => void;
  let fetched!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const received = new Promise<void>((resolve) => { fetched = resolve; });
  let held = false;
  await page.route(url, async (route) => {
    if (held || route.request().method() !== method) return route.fallback();
    held = true;
    const headers = origin ? { ...await route.request().allHeaders(), origin } : undefined;
    const response = await route.fetch(headers ? { headers } : undefined);
    fetched();
    await gate;
    await route.fulfill({ response });
  });
  return { release, received };
}

test("送信中に閉じて開き直したフォームの下書きは、先の送信が終わっても残す", async ({ page, baseURL }) => {
  const [questionId] = await createQuestions(marker, [{ title: "開き直す質問" }]);
  await createAnswer(questionId, "poc_s001", "コメントを付ける回答");
  await signIn(page, baseURL!, "poc_s002");
  await allowMutations(page, baseURL!);
  await page.goto(`/questions/${questionId}`);
  const post = await holdResponse(page, /\/api\/v1\/questions\/[^/?]+\/responses$/, "POST",
    canonicalOrigin ?? new URL(baseURL!).origin);

  const answer = page.getByRole("article", { name: "e2eの回答者名さんの回答" });
  const entry = answer.getByRole("button", { name: "コメントする" });
  await entry.click();
  await answer.getByRole("textbox", { name: "コメントの本文" }).fill("先に送るコメント");
  await answer.getByRole("button", { name: "投稿する" }).click();
  await post.received;
  await entry.click();
  await expect(answer.getByRole("textbox")).toHaveCount(0);
  await entry.click();
  await answer.getByRole("textbox", { name: "コメントの本文" }).fill("開き直して書いた下書き");

  post.release();
  await expect(page.getByRole("article", { name: "みなとさんのコメント" })).toContainText("先に送るコメント");
  await expect(answer.getByRole("textbox", { name: "コメントの本文" })).toHaveValue("開き直して書いた下書き");
});

test("続きのページの取得中に保存した編集を、遅れて届いた一覧で巻き戻さない", async ({ page, baseURL }) => {
  const [questionId] = await createQuestions(marker, [{ title: "取得中に編集する質問" }]);
  await createAnswers(questionId, "poc_s001", Array.from({ length: 51 }, (_, index) => `既存の回答${index + 1}`));
  await signIn(page, baseURL!, "poc_s002");
  await allowMutations(page, baseURL!);
  await page.goto(`/questions/${questionId}`);
  await page.getByRole("textbox", { name: "回答の本文" }).fill("編集前の回答");
  await page.getByRole("button", { name: "投稿する" }).click();
  const own = page.getByRole("article", { name: "みなとさんの回答" });
  await expect(own).toContainText("編集前の回答");

  // 編集前の内容を含む一覧の応答を受け取った後、画面へ届ける前に止める。
  const more = await holdResponse(page, /\/api\/v1\/questions\/[^/?]+\/responses\?/, "GET");
  await page.getByRole("button", { name: "さらに表示" }).click();
  await more.received;
  await own.getByRole("button", { name: "回答を編集" }).click();
  await own.getByRole("textbox", { name: "回答の本文" }).fill("保存した編集");
  await own.getByRole("button", { name: "保存する" }).click();
  await expect(own).toContainText("保存した編集");

  more.release();
  await expect(page.getByText("既存の回答51", { exact: true })).toBeVisible();
  await expect(own).toContainText("保存した編集");
  await expect(own).not.toContainText("編集前の回答");
  // 続きのページの位置（作成日時の順）へ移す。
  const bodies = await page.getByRole("region", { name: "回答・コメント" }).getByRole("article").allInnerTexts();
  expect(bodies.slice(-2).map((text) => text.match(/既存の回答51|保存した編集/)?.[0])).toEqual(["既存の回答51", "保存した編集"]);
  // 再度の編集も、最新の版番号で保存できる。
  await own.getByRole("button", { name: "回答を編集" }).click();
  await own.getByRole("textbox", { name: "回答の本文" }).fill("2回目の編集");
  await own.getByRole("button", { name: "保存する" }).click();
  await expect(own).toContainText("2回目の編集");
});

test("続きのページを読み込む前に投稿した投稿を編集しても、表示位置を変えない", async ({ page, baseURL }) => {
  const [questionId] = await createQuestions(marker, [{ title: "投稿を続ける質問" }]);
  await createAnswers(questionId, "poc_s001", Array.from({ length: 51 }, (_, index) => `既存の回答${index + 1}`));
  await signIn(page, baseURL!, "poc_s002");
  await allowMutations(page, baseURL!);
  await page.goto(`/questions/${questionId}`);
  const answerBody = page.getByRole("textbox", { name: "回答の本文" });
  for (const text of ["1件目の新しい回答", "2件目の新しい回答"]) {
    await answerBody.fill(text);
    await page.getByRole("button", { name: "投稿する" }).click();
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  }
  const first = page.getByRole("article", { name: "みなとさんの回答" }).filter({ hasText: "1件目の新しい回答" });
  await first.getByRole("button", { name: "回答を編集" }).click();
  await first.getByRole("textbox", { name: "回答の本文" }).fill("1件目を編集した回答");
  await first.getByRole("button", { name: "保存する" }).click();
  await expect(page.getByText("1件目を編集した回答", { exact: true })).toBeVisible();

  const bodies = await page.getByRole("region", { name: "回答・コメント" }).getByRole("article").allInnerTexts();
  expect(bodies.slice(-2).map((text) => text.match(/1件目を編集した回答|2件目の新しい回答/)?.[0]))
    .toEqual(["1件目を編集した回答", "2件目の新しい回答"]);
});

test("遅れて届いた個別取得の古い版で、表示中の新しい版を上書きしない", async ({ page, baseURL }) => {
  const [questionId] = await createQuestions(marker, [{ title: "別の画面でも編集する質問" }]);
  const answerId = await createAnswer(questionId, "poc_s002", "版1の回答");
  await signIn(page, baseURL!, "poc_s002");
  await allowMutations(page, baseURL!);
  const origin = canonicalOrigin ?? new URL(baseURL!).origin;
  // 別の画面からの編集。同じセッションで、画面を通さずに保存する。
  const editElsewhere = async (expectedVersion: number, bodyMarkdown: string) => {
    const response = await page.request.patch(`/api/v1/responses/${answerId}`, {
      headers: { Origin: origin, "Idempotency-Key": randomUUID() }, data: { expectedVersion, bodyMarkdown },
    });
    expect(response.status()).toBe(200);
  };
  await page.goto(`/questions/${questionId}`);

  const own = page.getByRole("article", { name: "e2eの回答者名さんの回答" });
  await own.getByRole("button", { name: "回答を編集" }).click();
  const body = own.getByRole("textbox", { name: "回答の本文" });
  await body.fill("画面での入力");
  await editElsewhere(1, "版2の回答");
  await own.getByRole("button", { name: "保存する" }).click();
  await expect(own.getByRole("alert")).toContainText("回答が更新されています");

  // 版2を受け取った個別取得を止めている間に版3が保存され、次の読み込みで版3を表示する。
  const stale = await holdResponse(page, new RegExp(`/api/v1/responses/${answerId}$`), "GET");
  const reload = own.getByRole("button", { name: "最新の内容を読み込む" });
  await reload.click();
  await stale.received;
  await editElsewhere(2, "版3の回答");
  await reload.click();
  await expect(body).toHaveValue("版3の回答");

  const delivered = page.waitForResponse((response) => response.url().endsWith(`/api/v1/responses/${answerId}`));
  stale.release();
  await delivered;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(body).toHaveValue("版3の回答");
  await body.fill("最新の版からの編集");
  await own.getByRole("button", { name: "保存する" }).click();
  await expect(own).toContainText("最新の版からの編集");
});

test("個別取得の古い版を先に反映しても、後から届いた一覧の新しい版を使う", async ({ page, baseURL }) => {
  const [questionId] = await createQuestions(marker, [{ title: "一覧のほうが新しい質問" }]);
  await createAnswers(questionId, "poc_s001", Array.from({ length: 51 }, (_, index) => `既存の回答${index + 1}`));
  await signIn(page, baseURL!, "poc_s002");
  await allowMutations(page, baseURL!);
  const origin = canonicalOrigin ?? new URL(baseURL!).origin;
  await page.goto(`/questions/${questionId}`);

  // 投稿直後の個別取得は版1を受け取ったまま止める。
  const single = await holdResponse(page, /\/api\/v1\/responses\/[^/?]+$/, "GET");
  const posted = page.waitForResponse((response) => response.request().method() === "POST"
    && /\/api\/v1\/questions\/[^/?]+\/responses$/.test(response.url()));
  await page.getByRole("textbox", { name: "回答の本文" }).fill("版1の新しい回答");
  await page.getByRole("button", { name: "投稿する" }).click();
  const answerId: string = (await (await posted).json()).data.resource.id;
  await single.received;

  // 別の画面で版2を保存し、続きのページはその版2を受け取ったまま止める。
  const saved = await page.request.patch(`/api/v1/responses/${answerId}`, {
    headers: { Origin: origin, "Idempotency-Key": randomUUID() }, data: { expectedVersion: 1, bodyMarkdown: "版2の回答" },
  });
  expect(saved.status()).toBe(200);
  const more = await holdResponse(page, /\/api\/v1\/questions\/[^/?]+\/responses\?/, "GET");
  await page.getByRole("button", { name: "さらに表示" }).click();
  await more.received;

  const own = page.getByRole("article", { name: "みなとさんの回答" });
  single.release();
  await expect(own).toContainText("版1の新しい回答");
  more.release();
  await expect(page.getByText("既存の回答51", { exact: true })).toBeVisible();
  await expect(own).toContainText("版2の回答");

  // 次の編集も版2から送るため、競合にならない。
  await own.getByRole("button", { name: "回答を編集" }).click();
  await own.getByRole("textbox", { name: "回答の本文" }).fill("版3の回答");
  await own.getByRole("button", { name: "保存する" }).click();
  await expect(own).toContainText("版3の回答");
});

test("AC-09 モバイルでキーボードを使って、確認のうえ自分の回答と質問を削除し、残存スレッドを表示する", async ({ page, baseURL }) => {
  const [questionId] = await createQuestions(marker, [{ title: "削除する質問" }]);
  // 通知の宛先を poc_a001 にしないよう、質問者・回答者を在校生にする。
  await createAnswer(questionId, "poc_s001", "削除する回答");
  await createAnswer(questionId, "poc_s002", "他人の回答");
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, baseURL!, "poc_s001");
  await allowMutations(page, baseURL!);
  await page.goto(`/questions/${questionId}`);

  const own = page.getByRole("article", { name: "e2eの回答者名さんの回答" }).filter({ hasText: "削除する回答" });
  const others = page.getByRole("article", { name: "e2eの回答者名さんの回答" }).filter({ hasText: "他人の回答" });
  await expect(others.getByRole("button", { name: "回答を削除" })).toHaveCount(0);
  await own.getByRole("button", { name: "コメントする" }).click();
  await own.getByRole("textbox", { name: "コメントの本文" }).fill("残るコメント");
  await own.getByRole("button", { name: "投稿する" }).click();
  const comment = page.getByRole("article", { name: "はるさんのコメント" });
  await expect(comment).toContainText("残るコメント");

  // 削除の入口をキーボードで開き、取り消すと何も変えない。
  const deleteAnswer = own.getByRole("button", { name: "回答を削除" });
  await deleteAnswer.focus();
  await page.keyboard.press("Enter");
  const answerDialog = page.getByRole("dialog", { name: "回答を削除" });
  await expect(answerDialog).toBeVisible();
  await expect(answerDialog).toContainText("削除する回答");
  await expect(answerDialog).toHaveAccessibleDescription(/この回答へのコメント・返信は削除されず/);
  await expect(answerDialog.getByRole("button", { name: "キャンセル" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(answerDialog).toBeHidden();
  await expect(own).toContainText("削除する回答");

  await deleteAnswer.click();
  await answerDialog.getByRole("button", { name: "キャンセル" }).press("Tab");
  await expect(answerDialog.getByRole("button", { name: "削除する" })).toBeFocused();
  await page.keyboard.press("Enter");
  const thread = page.getByRole("region", { name: "回答・コメント" });
  await expect(thread.getByRole("status")).toHaveText("回答を削除しました。");
  const deletedAnswer = thread.getByRole("article", { name: "回答" }).filter({ hasText: "この回答は削除されました。" });
  await expect(deletedAnswer).toBeFocused();
  await expect(thread.getByText("削除する回答")).toHaveCount(0);
  // 子のコメントは、削除した回答の下に残る。`has` の内側は外側の要素からの相対的な指定にする。
  const deletedItem = thread.getByRole("listitem").filter({
    has: page.getByRole("article", { name: "回答", exact: true }).filter({ hasText: "この回答は削除されました。" }),
  });
  await expect(deletedItem.getByRole("article", { name: "はるさんのコメント" })).toContainText("残るコメント");

  await page.getByRole("button", { name: "質問を削除" }).click();
  const questionDialog = page.getByRole("dialog", { name: "質問を削除" });
  await expect(questionDialog).toContainText("削除する質問");
  await questionDialog.getByRole("button", { name: "削除する" }).click();
  await expect(page.getByText("この質問は削除されました。")).toBeVisible();
  await expect(page.getByRole("heading", { name: "削除する質問" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "質問を削除" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "質問を編集" })).toHaveCount(0);
  await expect(comment).toContainText("残るコメント");
  await expect(others).toContainText("他人の回答");

  // 再読込しても、削除した本文を出さずに残存スレッドを表示する。
  await page.reload();
  await expect(page.getByText("この質問は削除されました。")).toBeVisible();
  await expect(page.getByText("この回答は削除されました。")).toBeVisible();
  await expect(page.getByRole("article", { name: "はるさんのコメント" })).toContainText("残るコメント");
  await expect(page.getByText("削除する回答")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(0);
});
