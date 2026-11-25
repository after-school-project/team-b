import { expect, test, type Locator, type Page } from "@playwright/test";
import { bumpUserVersion, createGraduatingStudents, removeGraduatingStudents, setUserState, userIdOf } from "./database";
import { canonicalOrigin, signIn } from "./session";

/**
 * 卒業区分の一括変更・修正・履歴（AD-13）を実セッションで確認する（#8 ⑥）。準備手順は docs/development/quality-and-poc.md の
 * 「ホストでのE2E」を参照する。seed のパスワードを記録に残さないため、トレースなどを無効にする。
 *
 * ほかのテスト（卒業生検索など）に影響しないよう、掲載希望のない利用者（poc_suspended・poc_s_mgr）と、
 * このファイルで作る一時的な利用者だけの区分を変える。
 */
test.use({ trace: "off", screenshot: "off", video: "off" });

async function openAsSchool(page: Page, baseURL: string, path: string) {
  const origin = canonicalOrigin ?? new URL(baseURL).origin;
  await page.route("**/api/v1/**", async (route) => {
    if (["GET", "HEAD"].includes(route.request().method())) return route.continue();
    await route.fulfill({ response: await route.fetch({ headers: { ...await route.request().allHeaders(), origin } }) });
  });
  await signIn(page, baseURL, "poc_school");
  await page.goto(path);
  // 画面が操作を受け付ける前のチェックは、動き出したときに失われる。検索フォームが動き出すまで待つ。
  await page.waitForFunction(() => {
    const form = document.querySelector("main form");
    return form !== null && Object.keys(form).some((key) => key.startsWith("__reactProps"));
  });
}

const candidate = (page: Page, name: string): Locator =>
  page.getByRole("form", { name: "卒業生への一括変更" }).getByRole("checkbox", { name, exact: true });

async function expectNoHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

test("未認証で開くと、戻り先付きでログイン画面に移る", async ({ page }) => {
  await page.goto("/admin/graduation?mode=history");
  await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent("/admin/graduation?mode=history")}`);
});

for (const username of ["poc_s002", "poc_staff", "poc_a_mgr", "poc_staff_mgr"]) {
  test(`SEC-28 学校管理者以外（${username}）がURLを直接開くと、拒否表示だけになる`, async ({ page, baseURL }) => {
    await signIn(page, baseURL!, username);
    for (const path of ["/admin/graduation", "/admin/graduation?mode=correction", "/admin/graduation?mode=history"]) {
      const response = await page.goto(path);
      await expect(page.getByRole("heading", { name: "この画面を利用する権限がありません。" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "卒業区分の変更" })).toHaveCount(0);
      expect(await response!.text()).not.toContain("あおい");
    }
  });
}

// 候補の一覧を共有するため、一時的な利用者を作るテストと並行させない。
test.describe("区分の変更と候補", () => {
  test.describe.configure({ mode: "serial" });

  test.describe("区分の変更", () => {
    const reset = async () => {
      for (const username of ["poc_suspended", "poc_s_mgr"]) await setUserState(username, { baseRole: "student", isGraduating: false });
    };
    test.beforeEach(async () => {
      await reset();
      for (const username of ["poc_suspended", "poc_s_mgr"]) await setUserState(username, { isGraduating: true });
    });
    test.afterAll(reset);

    test("キーボードだけで対象を選び、確認して一括変更し、履歴を確認できる", async ({ page, baseURL }) => {
      await openAsSchool(page, baseURL!, "/admin/graduation");
      const requests: string[] = [];
      page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/graduation/")) requests.push(request.url()); });
      const submit = page.getByRole("button", { name: "選択した人を卒業生に変更する" });
      const dialog = page.getByRole("dialog");

      // 選択しないと確定できない。
      await submit.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("form", { name: "卒業生への一括変更" }).getByRole("alert")).toHaveText("卒業生に変更する人を選択してください。");
      await expect(dialog).toHaveCount(0);

      for (const name of ["りく", "在校生アプリ管理者"]) {
        await candidate(page, name).focus();
        await page.keyboard.press("Space");
        await expect(candidate(page, name)).toBeChecked();
      }
      await expect(page.getByText("2人を選択中")).toBeVisible();
      await submit.focus();
      await page.keyboard.press("Enter");
      await expect(dialog.getByRole("heading", { name: "2人を卒業生に変更しますか？" })).toBeVisible();
      await expect(dialog.getByRole("list", { name: "変更する人" }).getByRole("listitem")).toHaveCount(2);
      // 同じ表示名の人と取り違えないよう、選んだ人のユーザーIDを示す。
      for (const [name, username] of [["りく", "poc_suspended"], ["在校生アプリ管理者", "poc_s_mgr"]] as const) {
        await expect(dialog.getByText(`${name}（ID：${await userIdOf(username)}）`, { exact: true })).toBeVisible();
      }
      // 閉じても送信せず、選択を保つ。
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(submit).toBeFocused();
      expect(requests).toEqual([]);

      await page.keyboard.press("Enter");
      await dialog.getByRole("button", { name: "卒業生に変更する" }).focus();
      await page.keyboard.press("Enter");
      const result = page.getByRole("status").filter({ hasText: "2人を卒業生に変更しました。" });
      await expect(result).toBeFocused();
      expect(requests).toHaveLength(1);
      await expect(candidate(page, "りく")).toHaveCount(0);
      await expect(candidate(page, "みなと")).toBeVisible();

      await page.getByRole("link", { name: "この変更の履歴を見る" }).click();
      await expect(page.getByRole("heading", { name: /変更の一覧/ })).toContainText("2件");
      const entries = page.getByRole("region", { name: /変更の一覧/ }).getByRole("listitem");
      await expect(entries).toHaveCount(2);
      await expect(entries.filter({ hasText: "りく" })).toContainText("在校生（卒業予定） → 卒業生");
      await expect(entries.filter({ hasText: "りく" })).toContainText("実行者：学校管理者（サンプル）");
    });

    test("確認ダイアログを閉じた直後にもう一度操作しても、ダイアログを開き直せる", async ({ page, baseURL }) => {
      await openAsSchool(page, baseURL!, "/admin/graduation");
      const dialog = page.getByRole("dialog");
      await candidate(page, "りく").check();
      await page.getByRole("button", { name: "選択した人を卒業生に変更する" }).click();
      await expect(dialog).toBeVisible();

      // Esc と同じ手順（cancel → close）で閉じ、close イベントが届く前に元の操作をもう一度実行してから、close の到着を待つ。
      const order = await page.evaluate(async () => {
        const element = document.querySelector<HTMLDialogElement>("dialog[open]")!;
        let closeArrived = false;
        const arrival = new Promise<void>((resolve) => {
          element.addEventListener("close", () => { closeArrived = true; resolve(); }, { once: true });
        });
        element.requestClose();
        for (let tick = 0; tick < 10; tick++) await Promise.resolve();
        const closedBeforeReopen = !element.open;
        document.querySelector<HTMLButtonElement>('form[aria-label="卒業生への一括変更"] button[type="submit"]')!.click();
        const arrivedBeforeReopen = closeArrived;
        await arrival;
        return { closedBeforeReopen, arrivedBeforeReopen };
      });
      expect(order).toEqual({ closedBeforeReopen: true, arrivedBeforeReopen: false });

      // 遅れて届いた close で閉じず、通常どおりキャンセルできる。
      await expect(dialog.getByRole("heading", { name: "1人を卒業生に変更しますか？" })).toBeVisible();
      await dialog.getByRole("button", { name: "キャンセル" }).click();
      await expect(dialog).toHaveCount(0);
    });

    test("一括変更した利用者を履歴から選び、元の区分へ修正できる。管理権限は維持される", async ({ page, baseURL, browser }) => {
      await openAsSchool(page, baseURL!, "/admin/graduation");
      await candidate(page, "在校生アプリ管理者").check();
      await page.getByRole("button", { name: "選択した人を卒業生に変更する" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "卒業生に変更する" }).click();
      await expect(page.getByRole("status").filter({ hasText: "1人を卒業生に変更しました。" })).toBeVisible();

      // 区分を変えてもアプリ管理者の権限は変わらない。
      const context = await browser.newContext({ baseURL });
      const manager = await context.newPage();
      await signIn(manager, baseURL!, "poc_s_mgr");
      await manager.goto("/admin/profile-reviews");
      await expect(manager.getByRole("heading", { level: 1, name: "プロフィール再公開審査" })).toBeVisible();
      await context.close();

      await page.getByRole("link", { name: "この変更の履歴を見る" }).click();
      await page.getByRole("link", { name: "この利用者の区分を修正" }).click();
      const heading = page.getByRole("heading", { name: "在校生アプリ管理者 の区分の修正" });
      await expect(heading).toBeFocused();
      const form = page.getByRole("form", { name: "区分の修正" });
      await expect(form.getByRole("radio", { name: "卒業生（現在の区分）" })).toBeDisabled();
      await form.getByRole("button", { name: "区分を修正する" }).click();
      await expect(form.getByRole("alert")).toHaveText("修正後の区分を選択してください。");

      await form.getByRole("radio", { name: "在校生（卒業予定）", exact: true }).focus();
      await page.keyboard.press("Space");
      await form.getByRole("button", { name: "区分を修正する" }).focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "区分を修正しますか？" });
      await expect(dialog).toContainText("卒業生 → 在校生（卒業予定）");
      await dialog.getByRole("button", { name: "区分を修正する" }).click();
      await expect(page.getByRole("status").filter({ hasText: "区分を「在校生（卒業予定）」に修正しました。" })).toBeFocused();
      await expect(form.getByRole("radio", { name: "在校生（卒業予定）（現在の区分）" })).toBeDisabled();

      await page.getByRole("link", { name: "この利用者の変更履歴" }).click();
      const entries = page.getByRole("region", { name: /変更の一覧/ }).getByRole("listitem");
      await expect(entries.first()).toContainText("卒業生 → 在校生（卒業予定）");
      await expect(entries.first()).toContainText("修正");
    });

    test("表示後に対象が変わると誰も変更せず、最新の内容を読み込める", async ({ page, baseURL, browser }) => {
      await openAsSchool(page, baseURL!, "/admin/graduation");
      for (const name of ["りく", "在校生アプリ管理者"]) await candidate(page, name).check();

      // 別の画面で1人の区分を修正する。
      const context = await browser.newContext({ baseURL });
      const other = await context.newPage();
      await openAsSchool(other, baseURL!, `/admin/graduation?mode=correction&user=${await userIdOf("poc_suspended")}`);
      await other.getByRole("radio", { name: "在校生", exact: true }).check();
      await other.getByRole("button", { name: "区分を修正する" }).click();
      await other.getByRole("dialog").getByRole("button", { name: "区分を修正する" }).click();
      await expect(other.getByRole("status").filter({ hasText: "区分を「在校生」に修正しました。" })).toBeVisible();
      await context.close();

      await page.getByRole("button", { name: "選択した人を卒業生に変更する" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "卒業生に変更する" }).click();
      const alert = page.getByRole("form", { name: "卒業生への一括変更" }).getByRole("alert");
      await expect(alert).toContainText("内容が更新されています。最新の内容を確認してください。");
      await expect(alert).toBeFocused();
      await alert.getByRole("button", { name: "最新の内容を読み込む" }).click();
      await expect(candidate(page, "りく")).toHaveCount(0);
      await expect(candidate(page, "在校生アプリ管理者")).toBeVisible();
    });

    test("応答を読めなかった場合は、同じ再送キーで送り直して結果を確認できる", async ({ page, baseURL }) => {
      await openAsSchool(page, baseURL!, "/admin/graduation");
      const origin = canonicalOrigin ?? new URL(baseURL!).origin;
      const keys: string[] = [];
      await page.route("**/graduation/changes", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const headers = await route.request().allHeaders();
        keys.push(headers["idempotency-key"]);
        const response = await route.fetch({ headers: { ...headers, origin } });
        if (keys.length === 1) return route.fulfill({ status: response.status(), contentType: "application/json", body: "{\"data\":" });
        await route.fulfill({ response });
      });
      await candidate(page, "りく").check();
      const change = async () => {
        await page.getByRole("button", { name: "選択した人を卒業生に変更する" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "卒業生に変更する" }).click();
      };
      await change();
      await expect(page.getByRole("form", { name: "卒業生への一括変更" }).getByRole("alert")).toContainText("結果を確認できませんでした。");
      await expect(candidate(page, "りく")).toBeChecked();
      await change();
      await expect(page.getByRole("status").filter({ hasText: "1人を卒業生に変更しました。" })).toBeVisible();
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
    });

    test("検索条件を欄ごとに案内し、条件のクリアで未送信の入力も消す", async ({ page, baseURL }) => {
      await openAsSchool(page, baseURL!, "/admin/graduation?mode=correction&graduationYear=26");
      const year = page.getByRole("textbox", { name: "卒業年度" });
      await expect(year).toHaveAccessibleDescription(/卒業年度は4桁の半角数字で入力してください。/);
      await expect(year).toHaveValue("26");
      await page.getByRole("textbox", { name: "キーワード" }).fill("未送信");
      await page.getByRole("button", { name: "条件をクリア" }).click();
      await expect(page).toHaveURL("/admin/graduation?mode=correction");
      await expect(page.getByRole("textbox", { name: "キーワード" })).toHaveValue("");

      await page.getByRole("textbox", { name: "キーワード" }).fill("あおい");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: /在校生・卒業生/ })).toContainText("1人");
      // 学校職員は修正の対象にならない。
      await page.goto(`/admin/graduation?mode=correction&user=${await userIdOf("poc_staff_mgr")}`);
      await expect(page.getByText("この利用者の区分は修正できません。")).toBeVisible();
    });

    test("モバイル幅でも横スクロールなしで、選択・確認・修正・履歴を使える", async ({ page, baseURL }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await openAsSchool(page, baseURL!, "/admin/graduation");
      await expectNoHorizontalScroll(page);
      await candidate(page, "りく").check();
      const submit = page.getByRole("button", { name: "選択した人を卒業生に変更する" });
      expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await submit.click();
      const dialog = page.getByRole("dialog");
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
      await dialog.getByRole("button", { name: "キャンセル" }).click();
      await page.goto(`/admin/graduation?mode=correction&user=${await userIdOf("poc_suspended")}`);
      await expect(page.getByRole("heading", { name: "りく の区分の修正" })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.goto("/admin/graduation?mode=history");
      await expect(page.getByRole("heading", { name: /変更の一覧/ })).toBeVisible();
      await expectNoHorizontalScroll(page);
    });
  });

  test.describe("多くの候補", () => {
    const department = "E2E確認用の学科";
    test.beforeEach(async () => {
      await removeGraduatingStudents();
      await createGraduatingStudents(department, 105);
    });
    test.afterEach(removeGraduatingStudents);

    test("続きの読み込み中に一括変更が確定したら、遅れて届いた応答を使わず、最新の版で続けて変更できる", async ({ page, baseURL }) => {
      await openAsSchool(page, baseURL!, `/admin/graduation?department=${encodeURIComponent(department)}`);
      let release = () => {};
      const released = new Promise<void>((resolve) => { release = resolve; });
      let fetched = () => {};
      const oldResponse = new Promise<void>((resolve) => { fetched = resolve; });
      // 続きの応答は、変更前の内容をサーバーから受け取った後、届くのを遅らせる。
      await page.route("**/graduation/candidates?*", async (route) => {
        const response = await route.fetch();
        const body = await response.body();
        fetched();
        await released;
        // 取得を中止した場合は、応答を返す相手がいない。
        await route.fulfill({ response, body }).catch(() => {});
      }, { times: 1 });
      await page.getByRole("button", { name: "さらに表示" }).click();
      await oldResponse;
      // 変更後の一覧に加わる人（051）の版番号を、応答の取得後に進める。
      await bumpUserVersion("e2e-graduating-051");

      const change = async (...names: string[]) => {
        for (const name of names) await candidate(page, name).check();
        await page.getByRole("button", { name: "選択した人を卒業生に変更する" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "卒業生に変更する" }).click();
        await expect(page.getByRole("status").filter({ hasText: `${names.length}人を卒業生に変更しました。` })).toBeVisible();
      };
      await change("e2e-graduating-000", "e2e-graduating-001");
      await expect(candidate(page, "e2e-graduating-051")).toBeVisible();
      release();
      await page.waitForTimeout(500);
      await expect(page.getByRole("checkbox", { name: "表示中の50人をすべて選択" })).toBeVisible();
      await expect(candidate(page, "e2e-graduating-000")).toHaveCount(0);

      await change("e2e-graduating-051");
      // 再取得した一覧（052 が加わる）を待ってから、続きを読み込む。続きの読み込みは、確定後もそのまま使える。
      await expect(candidate(page, "e2e-graduating-052")).toBeVisible();
      await page.getByRole("button", { name: "さらに表示" }).click();
      await expect(page.getByRole("checkbox", { name: "表示中の100人をすべて選択" })).toBeVisible();
    });

    test("続きを読み込んでも選択を保ち、100人を超える選択は送信せずに案内し、100人までは変更できる", async ({ page, baseURL }) => {
      await openAsSchool(page, baseURL!, `/admin/graduation?department=${encodeURIComponent(department)}`);
      await expect(page.getByRole("heading", { name: /卒業予定の在校生/ })).toContainText("105人");
      const all = page.getByRole("checkbox", { name: /表示中の\d+人をすべて選択/ });
      await all.check();
      await expect(page.getByText("50人を選択中")).toBeVisible();
      for (const shown of [100, 105]) {
        await page.getByRole("button", { name: "さらに表示" }).click();
        await expect(page.getByRole("checkbox", { name: `表示中の${shown}人をすべて選択` })).not.toBeChecked();
        await expect(page.getByText("50人を選択中")).toBeVisible();
      }
      await expect(page.getByRole("button", { name: "さらに表示" })).toHaveCount(0);

      await all.check();
      const submit = page.getByRole("button", { name: "選択した人を卒業生に変更する" });
      await submit.click();
      await expect(page.getByText("一度に変更できるのは100人までです。選択を減らしてください。（現在105人）")).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      for (let index = 100; index < 105; index++) await candidate(page, `e2e-graduating-${index}`).uncheck();
      await submit.click();
      await page.getByRole("dialog").getByRole("button", { name: "卒業生に変更する" }).click();
      await expect(page.getByRole("status").filter({ hasText: "100人を卒業生に変更しました。" })).toBeVisible();
      await expect(page.getByRole("checkbox", { name: "表示中の5人をすべて選択" })).not.toBeChecked();
      await expect(page.getByRole("heading", { name: /卒業予定の在校生/ })).toContainText("5人");
    });
  });
});
