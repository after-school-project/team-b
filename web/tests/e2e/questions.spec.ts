import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createQuestions, removeQuestions } from "./database";
import { canonicalOrigin, signIn } from "./session";

/**
 * Q&A一覧・検索（QA-01）と質問の詳細（QA-02）を実セッションで確認する（#9 ①③）。
 * 準備手順は docs/development/quality-and-poc.md の「ホストでのE2E」を参照する。seed のパスワードを記録に残さないため、
 * トレースなどを無効にする。
 *
 * ほかのテストと並行しても件数が変わらないよう、このファイルで作る質問は、テストごとに異なる目印で検索する。
 */
test.use({ trace: "off", screenshot: "off", video: "off" });

const seedTitle = "チーム開発で最初に揃えておくとよいことは？";
const count = (page: Page) => page.getByRole("heading", { level: 2, name: /^質問 \d+件$/ });

let marker: string;
test.beforeEach(() => {
  marker = `e2e-question-${randomUUID()}`;
});
test.afterEach(() => removeQuestions(marker));

test("AC-03・AC-04 モバイルで質問を投稿・編集し、競合時に入力を保持する", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, baseURL!, "poc_s001");
  const origin = canonicalOrigin ?? new URL(baseURL!).origin;
  await page.context().route(/\/api\/v1\/questions(?:\/[^/?]+)?$/, async (route) => {
    if (route.request().method() === "GET") return route.continue();
    await route.fulfill({ response: await route.fetch({ headers: { ...await route.request().allHeaders(), origin } }) });
  });
  try {
    await page.goto("/questions?category=learning");
    const entry = page.getByRole("link", { name: "質問を投稿" });
    await entry.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "質問の新規作成" })).toBeVisible();
    await page.getByRole("link", { name: "キャンセル" }).click();
    await expect(page).toHaveURL("/questions?category=learning");
    await entry.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(0);

    await page.getByRole("textbox", { name: "タイトル" }).fill("新規質問");
    await page.keyboard.press("Tab");
    const category = page.getByRole("combobox", { name: "カテゴリー" });
    await expect(category).toBeFocused();
    await category.selectOption("learning");
    await page.keyboard.press("Tab");
    const body = page.getByRole("textbox", { name: "本文" });
    await expect(body).toBeFocused();
    await body.fill("<div>HTML</div>");
    await page.getByRole("button", { name: "投稿する" }).click();
    await expect(body).toHaveAccessibleDescription(/HTMLのタグは使えません/);
    await body.fill(`**質問本文**\n\n${marker}`);
    await page.getByRole("button", { name: "投稿する" }).click();
    await expect(page.getByRole("heading", { name: "新規質問" })).toBeVisible();
    await expect(page.getByText("質問本文", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "質問を編集" }).click();
    await expect(page.getByRole("heading", { name: "質問の編集" })).toBeVisible();
    const title = page.getByRole("textbox", { name: "タイトル" });
    await expect(title).toHaveValue("新規質問");
    await expect(category).toHaveValue("learning");

    const otherTab = await page.context().newPage();
    try {
      await otherTab.goto(page.url());
      await otherTab.getByRole("textbox", { name: "タイトル" }).fill("先に保存した質問");
      await otherTab.getByRole("button", { name: "保存する" }).click();
      await expect(otherTab.getByRole("heading", { name: "先に保存した質問" })).toBeVisible();
    } finally {
      await otherTab.close();
    }
    await title.fill("保存前の入力");
    await page.getByRole("button", { name: "保存する" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("質問が更新されています");
    await expect(title).toHaveValue("保存前の入力");
    await page.getByRole("button", { name: "最新の内容を読み込む" }).click();
    await expect(title).toHaveValue("先に保存した質問");
  } finally {
    await removeQuestions(marker, "poc_s001");
  }
});

test("AC-03 他人の編集画面とプロフィール非表示中の新規投稿を制限する", async ({ page, baseURL }) => {
  const [id] = await createQuestions(marker, [{ title: "他の利用者の質問" }]);
  await signIn(page, baseURL!, "poc_hidden");
  await page.goto("/questions");
  await expect(page.getByRole("link", { name: "質問を投稿" })).toHaveCount(0);
  await page.goto("/questions/new");
  await expect(page.getByText("プロフィールが非表示の間は、質問を投稿できません。")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "タイトル" })).toHaveCount(0);
  await page.goto(`/questions/${id}`);
  await expect(page.getByRole("link", { name: "質問を編集" })).toHaveCount(0);
  expect((await page.goto(`/questions/${id}/edit`))?.status()).toBe(404);
});

test("AC-01 共通ナビから一覧を開き、キーボードだけで検索して質問を開ける", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s002");
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主要メニュー" }).getByRole("link", { name: "Q&A" });
  await nav.click();
  await expect(page).toHaveURL("/questions");
  await expect(page.getByRole("heading", { level: 1, name: "Q&A" })).toBeVisible();
  await expect(nav).toHaveAttribute("aria-current", "page");

  await page.getByRole("textbox", { name: "キーワード" }).focus();
  await page.keyboard.type("チーム開発");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "カテゴリー" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "解決状態" })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/questions\?q=/);

  const link = page.getByRole("link", { name: seedTitle });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: seedTitle })).toBeVisible();
  await expect(page.getByText("初めてチームでWebアプリを作ります。", { exact: false })).toBeVisible();
  await expect(nav).toHaveAttribute("aria-current", "true");
  await page.getByRole("link", { name: "Q&A一覧へ" }).click();
  await expect(page).toHaveURL("/questions");
});

test("AC-01・AC-02 4カテゴリーと解決状態で絞り込め、非表示・削除済みの質問を件数と結果に含めない", async ({ page, baseURL }) => {
  await createQuestions(marker, [
    { title: "就職の未解決", category: "career" }, { title: "就職の解決済み", category: "career", resolution: "resolved" },
    { title: "雑談の未解決", category: "chat" }, { title: "見せない題名1", hidden: true }, { title: "見せない題名2", deleted: true },
  ]);
  await signIn(page, baseURL!, "poc_s002");
  await page.goto(`/questions?q=${marker}`);
  await expect(page.getByRole("combobox", { name: "カテゴリー" }).getByRole("option"))
    .toHaveText(["すべて", "就職・キャリア", "技術・学習", "制作・プロジェクト", "雑談"]);
  await expect(count(page)).toContainText("3件");
  await expect(page.getByText("見せない題名")).toHaveCount(0);

  await page.getByRole("combobox", { name: "カテゴリー" }).selectOption({ label: "就職・キャリア" });
  await page.getByRole("button", { name: "検索する" }).click();
  await expect(count(page)).toContainText("2件");
  await page.getByRole("combobox", { name: "解決状態" }).selectOption({ label: "解決済み" });
  await page.getByRole("button", { name: "検索する" }).click();
  await expect(count(page)).toContainText("1件");
  await expect(page.getByRole("link", { name: "就職の解決済み" })).toBeVisible();
  // 適用中の条件を、入力欄に残す。
  await expect(page.getByRole("combobox", { name: "カテゴリー" })).toHaveValue("career");
  await expect(page.getByRole("combobox", { name: "解決状態" })).toHaveValue("resolved");

  await page.getByRole("combobox", { name: "カテゴリー" }).selectOption({ label: "制作・プロジェクト" });
  await page.getByRole("button", { name: "検索する" }).click();
  await expect(page.getByText("条件に合う質問はありません。")).toBeVisible();

  await page.getByRole("button", { name: "条件をクリア" }).click();
  await expect(page).toHaveURL(/\/questions\??$/);
  await expect(page.getByRole("textbox", { name: "キーワード" })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "カテゴリー" })).toHaveValue("");
});

test("AC-02 条件を保ったままページを送り、最初のページへ戻れる", async ({ page, baseURL }) => {
  await createQuestions(marker, Array.from({ length: 21 }, (_, index) => ({ title: `質問${String(index).padStart(2, "0")}` })));
  await signIn(page, baseURL!, "poc_s002");
  await page.goto(`/questions?q=${marker}`);
  const links = page.getByRole("main").getByRole("listitem").getByRole("link");
  await expect(links).toHaveCount(20);
  const first = await links.allTextContents();
  await page.getByRole("link", { name: "次の20件を表示" }).click();
  await expect(links).toHaveCount(1);
  await expect(count(page)).toContainText("21件");
  expect(new Set([...first, ...await links.allTextContents()]).size).toBe(21);
  await page.getByRole("link", { name: "最初のページを表示" }).click();
  await expect(links).toHaveCount(20);
  await expect(page).toHaveURL(`/questions?q=${marker}`);
});

test("形式の誤った条件と、条件の合わないカーソルを画面内で案内する", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s002");
  await page.goto(`/questions?q=${"あ".repeat(101)}`);
  await expect(page.getByRole("alert").filter({ hasText: "検索条件を確認してください。（1件）" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "キーワード" })).toHaveAccessibleDescription(/キーワードは100文字以内で入力してください。/);
  await expect(page.getByRole("textbox", { name: "キーワード" })).toHaveValue("あ".repeat(101));
  for (const query of ["category=unknown", "resolution=closed", "q=a&q=b"]) {
    await page.goto(`/questions?${query}`);
    await expect(page.getByRole("alert").filter({ hasText: "検索条件を確認してください。" })).toBeVisible();
  }
  await page.goto("/questions?cursor=invalid");
  await page.getByRole("link", { name: "最初のページを表示する" }).click();
  await expect(page).toHaveURL("/questions");
  await expect(count(page)).toBeVisible();
});

test("AC-05 本文を制限Markdownで表示し、危険な要素を描画しない", async ({ page, baseURL }) => {
  const [id] = await createQuestions(marker, [{
    title: "Markdownの質問", category: "projects",
    body: "# 見出し\n\n**強調** [資料](https://example.com/docs) [危険](javascript:alert(1))\n\n<img src=x onerror=alert(1)>\n\n```\n<div>コード</div>\n```",
  }]);
  await signIn(page, baseURL!, "poc_s002");
  await page.goto(`/questions/${id}`);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1, name: "Markdownの質問" })).toBeVisible();
  await expect(main.getByRole("heading", { level: 2, name: "見出し" })).toBeVisible();
  await expect(main.getByRole("link", { name: "資料" })).toHaveAttribute("href", "https://example.com/docs");
  await expect(main.getByText("<div>コード</div>")).toBeVisible();
  await expect(main.getByRole("link", { name: "危険" })).toHaveCount(0);
  await expect(main.locator("img, script")).toHaveCount(0);
  await expect(main.getByText("未解決")).toBeVisible();
  await expect(main.getByText("制作・プロジェクト")).toBeVisible();
});

test("AC-06 削除済み・非表示の質問は状態だけを案内し、本人と管理者には非表示の内容を示す", async ({ page, browser, baseURL }) => {
  const [hidden, deleted] = await createQuestions(marker, [
    { title: "非表示の題名", body: "非表示の本文", hidden: true }, { title: "削除済みの題名", body: "削除済みの本文", deleted: true },
  ]);
  await signIn(page, baseURL!, "poc_s002");
  for (const [id, message] of [[hidden, "この質問は現在表示できません。"], [deleted, "この質問は削除されました。"]] as const) {
    await page.goto(`/questions/${id}`);
    await expect(page.getByText(message)).toBeVisible();
    // 画面に見えない部分（埋め込みデータなど）にも、閲覧できない内容を含めない。
    const html = await page.content();
    for (const secret of ["非表示の題名", "非表示の本文", "削除済みの題名", "削除済みの本文", "e2eの投稿者名"]) expect(html).not.toContain(secret);
  }

  for (const username of ["poc_s001", "poc_school"]) {
    const context = await browser.newContext({ baseURL });
    const viewer = await context.newPage();
    await signIn(viewer, baseURL!, username);
    await viewer.goto(`/questions/${hidden}`);
    await expect(viewer.getByRole("heading", { level: 1, name: "非表示の題名" })).toBeVisible();
    await expect(viewer.getByText("この質問は管理者により非表示になっています。", { exact: false })).toBeVisible();
    await viewer.goto(`/questions/${deleted}`);
    await expect(viewer.getByText("この質問は削除されました。")).toBeVisible();
    expect(await viewer.content()).not.toContain("削除済みの本文");
    await context.close();
  }
});

test("未認証で一覧・質問を開くとログイン画面に移り、ログイン後の戻り先に条件とIDを引き継ぐ", async ({ page }) => {
  await page.goto("/questions?category=career");
  await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent("/questions?category=career")}`);
  const path = `/questions/${randomUUID()}`;
  await page.goto(path);
  await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent(path)}`);
});

test("存在しない質問と形式の誤ったIDは404と日本語の案内になる", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s002");
  for (const id of [randomUUID(), "not-a-uuid"]) {
    const response = await page.goto(`/questions/${id}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "ページが見つかりません" })).toBeVisible();
  }
});

test("モバイル幅でも、長い題名・本文を横スクロールなしで表示する", async ({ page, baseURL }) => {
  const [id] = await createQuestions(marker, [{
    title: "a".repeat(100), body: `${"b".repeat(300)}\n\n${"- ".repeat(15)}深いリスト\n\n\`\`\`\n${"c".repeat(300)}\n\`\`\``,
  }]);
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, baseURL!, "poc_s002");
  for (const path of [`/questions?q=${marker}`, `/questions/${id}`]) {
    await page.goto(path);
    await expect(page.getByText("a".repeat(100))).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  await page.goto("/questions");
  for (const control of [page.getByRole("button", { name: "検索する" }), page.getByRole("combobox", { name: "カテゴリー" })]) {
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
});
