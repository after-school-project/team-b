import { expect, test, type Browser, type Page } from "@playwright/test";
import { resetProfileReviews, setUserState, userIdOf } from "./database";
import { canonicalOrigin, signIn } from "./session";

/**
 * ユーザー管理詳細（AD-11）とプロフィール再公開審査（AD-15）を実セッションで確認する（#8 ⑤、#7 から移管した管理画面の
 * 直接アクセス）。準備手順は docs/development/quality-and-poc.md の「ホストでのE2E」を参照する。
 * seed のパスワードを記録に残さないため、トレースなどを無効にする。
 *
 * ほかのテストと並行して状態を変えないよう、状態を変える利用者（poc_staff・poc_staff_mgr）はこのファイルだけで使う。
 */
test.use({ trace: "off", screenshot: "off", video: "off" });

const deniedTitle = "この画面を利用する権限がありません。";

/** 本番ビルドが受け付ける正規オリジンで更新を送り直す（my-profile.spec.ts と同じ扱い）。 */
async function routeCanonicalOrigin(page: Page, baseURL: string) {
  const origin = canonicalOrigin ?? new URL(baseURL).origin;
  await page.route("**/api/v1/**", async (route) => {
    if (["GET", "HEAD"].includes(route.request().method())) return route.continue();
    await route.fulfill({ response: await route.fetch({ headers: { ...await route.request().allHeaders(), origin } }) });
  });
}

/** 別の利用者のブラウザーを開く。 */
async function openAs(browser: Browser, baseURL: string, username: string): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signIn(page, baseURL, username);
  await routeCanonicalOrigin(page, baseURL);
  return page;
}

async function expectDenied(page: Page) {
  await expect(page.getByRole("heading", { level: 1, name: "管理エリア" })).toBeVisible();
  await expect(page.getByRole("heading", { name: deniedTitle })).toBeVisible();
  await expect(page.getByRole("heading", { name: "ユーザー管理" })).toHaveCount(0);
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("管理画面の直接アクセス（AD-11・AD-15）", () => {
  test("未認証で開くと、戻り先付きでログイン画面に移る", async ({ page }) => {
    const path = `/admin/users/${await userIdOf("poc_s002")}`;
    await page.goto(path);
    await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent(path)}`);
    await page.goto("/admin/profile-reviews?status=all");
    await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent("/admin/profile-reviews?status=all")}`);
  });

  for (const username of ["poc_s001", "poc_a001", "poc_hidden"]) {
    test(`一般利用者（${username}）がURLを直接開くと、拒否表示だけになる`, async ({ page, baseURL }) => {
      const userId = await userIdOf("poc_s002");
      await signIn(page, baseURL!, username);
      const response = await page.goto(`/admin/users/${userId}`);
      await expectDenied(page);
      // 管理データ（対象者の表示名）を、画面にも応答にも含めない。
      expect(await response!.text()).not.toContain("みなと");
      await expect(page.getByText("みなと")).toHaveCount(0);
      // 存在しない利用者でも同じ表示にし、対象者の有無を明かさない。
      await page.goto("/admin/users/no-such-user");
      await expectDenied(page);

      await page.goto("/admin/profile-reviews");
      await expectDenied(page);
      await expect(page.getByRole("heading", { name: /申請の一覧/ })).toHaveCount(0);
    });
  }

  for (const username of ["poc_school", "poc_s_mgr"]) {
    test(`有効な管理者（${username}）は開いて、利用者の基本情報を確認できる`, async ({ page, baseURL }) => {
      await signIn(page, baseURL!, username);
      await page.goto(`/admin/users/${await userIdOf("poc_s002")}`);
      await expect(page.getByRole("heading", { level: 1, name: "ユーザー管理" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: "みなと" })).toBeVisible();
      await expect(page.getByText("卒業予定", { exact: true })).toBeVisible();
      await expect(page.getByText("利用中", { exact: true })).toBeVisible();
      await expect(page.getByText("公開中", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "プロフィールを非表示にする" })).toBeVisible();
      // 本人確認情報は表示しない。
      await expect(page.getByText(/架空ユーザー|DEMO-/)).toHaveCount(0);
      const missing = await page.goto("/admin/users/no-such-user");
      expect(missing?.status()).toBe(404);
    });
  }

  test("アプリ管理者・学校管理者が対象の場合は、許可される操作だけを表示する", async ({ browser, baseURL }) => {
    const manager = `/admin/users/${await userIdOf("poc_a_mgr")}`;
    const school = `/admin/users/${await userIdOf("poc_school")}`;
    const asApp = await openAs(browser, baseURL!, "poc_s_mgr");
    await asApp.goto(manager);
    await expect(asApp.getByText("アプリ管理者のプロフィールは、学校管理者だけが非表示にできます。")).toBeVisible();
    await expect(asApp.getByRole("button", { name: "プロフィールを非表示にする" })).toHaveCount(0);
    await asApp.goto(school);
    await expect(asApp.getByText("学校管理者のプロフィールは、非表示の対象外です。")).toBeVisible();
    await asApp.context().close();

    const asSchool = await openAs(browser, baseURL!, "poc_school");
    await asSchool.goto(manager);
    await expect(asSchool.getByRole("button", { name: "プロフィールを非表示にする" })).toBeVisible();
    await expect(asSchool.getByText(/担当中の通報案件は引継ぎ待ちになります/)).toBeVisible();
    await asSchool.goto(school);
    await expect(asSchool.getByRole("button", { name: "プロフィールを非表示にする" })).toHaveCount(0);
    await asSchool.context().close();
  });

  test.describe("権限を失ったアプリ管理者", () => {
    test.describe.configure({ mode: "serial" });
    const restore = () => setUserState("poc_staff_mgr", { appManager: true, profileState: "public" });
    test.beforeEach(restore);
    test.afterEach(restore);

    for (const [label, state] of [
      ["プロフィール非表示中", { profileState: "hidden" }], ["権限解除後", { appManager: false }],
    ] as const) {
      test(`${label}は、ログイン中でもURLを直接開くと拒否表示になる`, async ({ page, baseURL }) => {
        const path = `/admin/users/${await userIdOf("poc_s002")}`;
        await signIn(page, baseURL!, "poc_staff_mgr");
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1, name: "ユーザー管理" })).toBeVisible();

        await setUserState("poc_staff_mgr", state);
        await page.goto(path);
        await expectDenied(page);
        await expect(page.getByText("みなと")).toHaveCount(0);
        await page.goto("/admin/profile-reviews");
        await expectDenied(page);
        // ログインは維持し、一般の画面は使える。
        await page.goto("/alumni");
        await expect(page.getByRole("heading", { level: 1, name: "卒業生検索" })).toBeVisible();
      });
    }
  });

  test("拒否表示を、モバイル幅とキーボードだけの操作で使える", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, baseURL!, "poc_s001");
    await page.goto(`/admin/users/${await userIdOf("poc_s002")}`);
    await expectDenied(page);
    await expectNoHorizontalScroll(page);
    const home = page.getByRole("link", { name: "ホームへ戻る" });
    await home.scrollIntoViewIfNeeded();
    await expect(home).toBeInViewport();
    expect((await home.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // 先頭から Tab だけで導線へ到達し、Enter でホームへ戻れる。
    await page.evaluate(() => { window.scrollTo(0, 0); (document.activeElement as HTMLElement | null)?.blur(); });
    for (let presses = 0; presses < 30; presses++) {
      await page.keyboard.press("Tab");
      if (await home.evaluate((element) => element === document.activeElement)) break;
    }
    await expect(home).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { level: 1, name: "ホーム" })).toBeVisible();
  });
});

test.describe("プロフィールの非表示と再公開審査", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(() => resetProfileReviews("poc_staff"));
  test.afterAll(() => resetProfileReviews("poc_staff"));

  test("キーボードだけで理由を入力し、確認ダイアログで確定して非表示にできる", async ({ page, baseURL }) => {
    await signIn(page, baseURL!, "poc_s_mgr");
    await routeCanonicalOrigin(page, baseURL!);
    await page.goto(`/admin/users/${await userIdOf("poc_staff")}`);
    const requests: string[] = [];
    page.on("request", (request) => { if (request.url().includes("/profile-hiding")) requests.push(request.method()); });

    const submit = page.getByRole("button", { name: "プロフィールを非表示にする" });
    const reason = page.getByRole("textbox", { name: /非表示の理由/ });
    await submit.focus();
    await page.keyboard.press("Enter");
    await expect(reason).toHaveAttribute("aria-invalid", "true");
    await expect(reason).toHaveAccessibleDescription(/非表示の理由を入力してください。/);
    const dialog = page.getByRole("dialog", { name: "プロフィールを非表示にしますか？" });
    await expect(dialog).toHaveCount(0);

    await reason.focus();
    await page.keyboard.insertText("公開表示名に個人情報が含まれています。");
    await submit.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("学校職員（サンプル）");
    // 最初のフォーカスはキャンセル。フォーカスはダイアログの外（背面の操作）へ移らない。
    await expect(dialog.getByRole("button", { name: "キャンセル" })).toBeFocused();
    for (let presses = 0; presses < 6; presses++) {
      await page.keyboard.press("Tab");
      await expect(submit).not.toBeFocused();
      await expect(reason).not.toBeFocused();
    }
    // Esc で閉じても送信せず、元の操作へフォーカスを戻し、入力を保つ。
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(submit).toBeFocused();
    await expect(reason).toHaveValue("公開表示名に個人情報が含まれています。");
    expect(requests).toEqual([]);

    await page.keyboard.press("Enter");
    await dialog.getByRole("button", { name: "非表示にする" }).focus();
    await page.keyboard.press("Enter");
    const result = page.getByRole("status").filter({ hasText: "プロフィールを非表示にしました。" });
    await expect(result).toBeVisible();
    await expect(result).toBeFocused();
    await expect(page.getByText("非表示", { exact: true })).toBeVisible();
    await expect(submit).toHaveCount(0);
    expect(requests).toEqual(["POST"]);

    // 一般の画面では状態案内だけになる。
    await page.goto(`/users/${await userIdOf("poc_staff")}`);
    await expect(page.getByText("このプロフィールは現在表示できません。")).toBeVisible();
  });

  test("本人の修正 → 競合 → 却下 → 再申請 → 承認を、各利用者の画面で確認できる", async ({ browser, baseURL }) => {
    await setUserState("poc_staff", { profileState: "hidden" });
    const owner = await openAs(browser, baseURL!, "poc_staff");
    const manager = await openAs(browser, baseURL!, "poc_s_mgr");
    const occupation = owner.getByRole("textbox", { name: "職種の内容" });
    const save = async (value: string) => {
      await occupation.fill(value);
      await owner.getByRole("button", { name: "保存する" }).click();
      await expect(owner.getByRole("status").filter({ hasText: "再公開の申請として審査されます。" })).toBeVisible();
    };

    await owner.goto("/me/profile");
    await owner.getByRole("radiogroup", { name: "職種の公開範囲" }).getByRole("radio", { name: "ログインした利用者に公開" }).check();
    await owner.getByRole("textbox", { name: "関心分野の内容" }).fill("本人だけの関心分野");
    await save("修正1");

    // 一覧から選ぶと、同じ画面に公開予定の項目だけを表示し、詳細の見出しへフォーカスを移す。
    await manager.goto("/admin/profile-reviews");
    await manager.getByRole("link", { name: "学校職員（サンプル）" }).focus();
    await manager.keyboard.press("Enter");
    await expect(manager).toHaveURL(/\/admin\/profile-reviews\?review=[0-9a-f-]{36}$/);
    const heading = manager.getByRole("heading", { name: "学校職員（サンプル） の再公開申請" });
    await expect(heading).toBeFocused();
    const detail = manager.getByRole("region", { name: "学校職員（サンプル） の再公開申請" });
    await expect(detail.getByText("修正1", { exact: true })).toBeVisible();
    await expect(manager.getByText("本人だけの関心分野")).toHaveCount(0);

    // 表示後に本人が修正すると、古い内容の承認は確定しない。
    await save("修正2");
    await manager.getByRole("button", { name: "承認する" }).click();
    const alert = manager.getByRole("form", { name: "再公開の審査" }).getByRole("alert");
    await expect(alert).toContainText("内容が更新されています。最新の内容を確認してください。");
    await expect(alert).toBeFocused();
    await alert.getByRole("button", { name: "最新の内容を読み込む" }).click();
    await expect(detail.getByText("修正2", { exact: true })).toBeVisible();

    // 却下には理由が必要。
    await manager.getByRole("button", { name: "却下する" }).click();
    const reason = manager.getByRole("textbox", { name: /却下の理由/ });
    await expect(reason).toHaveAccessibleDescription(/却下の理由を入力してください。/);
    await reason.fill("自己紹介を修正してください。");
    await manager.getByRole("button", { name: "却下する" }).click();
    const rejected = manager.getByRole("status").filter({ hasText: "再公開申請を却下しました。" });
    await expect(rejected).toBeFocused();
    await expect(detail.getByText("却下", { exact: true })).toBeVisible();
    await expect(manager.getByRole("button", { name: "承認する" })).toHaveCount(0);
    // 審査待ちの一覧からは除かれる。
    await expect(manager.getByRole("region", { name: /申請の一覧/ }).getByRole("link", { name: "学校職員（サンプル）" })).toHaveCount(0);

    await owner.reload();
    await expect(owner.getByText("非表示", { exact: true })).toBeVisible();
    await expect(owner.getByText("自己紹介を修正してください。")).toBeVisible();
    await save("修正3");

    await manager.goto("/admin/profile-reviews");
    await manager.getByRole("link", { name: "学校職員（サンプル）" }).click();
    await expect(detail.getByText("修正3", { exact: true })).toBeVisible();
    await manager.getByRole("button", { name: "承認する" }).click();
    await expect(manager.getByRole("status").filter({ hasText: "再公開を承認しました。" })).toBeFocused();
    await expect(detail.getByText("承認済み", { exact: true })).toBeVisible();

    await owner.reload();
    await expect(owner.getByText("公開中", { exact: true })).toBeVisible();
    await expect(owner.getByText("承認済み", { exact: true })).toBeVisible();

    // 状態の絞り込みで、確定した申請を確認できる。
    await manager.getByRole("navigation", { name: "申請の状態" }).getByRole("link", { name: "却下" }).click();
    await expect(manager).toHaveURL("/admin/profile-reviews?status=rejected");
    await expect(manager.getByRole("link", { name: "却下" })).toHaveAttribute("aria-current", "page");
    await expect(manager.getByRole("link", { name: "学校職員（サンプル）" }).first()).toBeVisible();
    await owner.context().close();
    await manager.context().close();
  });

  test("審査の応答を読めなかった場合は、同じ再送キーで送り直して結果を確認できる", async ({ browser, baseURL }) => {
    await setUserState("poc_staff", { profileState: "hidden" });
    const owner = await openAs(browser, baseURL!, "poc_staff");
    await owner.goto("/me/profile");
    await owner.getByRole("button", { name: "保存する" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "再公開の申請として審査されます。" })).toBeVisible();

    const manager = await openAs(browser, baseURL!, "poc_s_mgr");
    const origin = canonicalOrigin ?? new URL(baseURL!).origin;
    const keys: string[] = [];
    await manager.route("**/decision", async (route) => {
      const headers = await route.request().allHeaders();
      keys.push(headers["idempotency-key"]);
      const response = await route.fetch({ headers: { ...headers, origin } });
      // 1回目は、サーバーでは確定したが本文が途中で途切れた状態を再現する。
      if (keys.length === 1) return route.fulfill({ status: response.status(), contentType: "application/json", body: "{\"data\":" });
      await route.fulfill({ response });
    });
    await manager.goto("/admin/profile-reviews");
    await manager.getByRole("link", { name: "学校職員（サンプル）" }).click();
    await manager.getByRole("button", { name: "承認する" }).click();
    await expect(manager.getByRole("form", { name: "再公開の審査" }).getByRole("alert"))
      .toContainText("審査の結果を確認できませんでした。");
    await manager.getByRole("button", { name: "承認する" }).click();
    await expect(manager.getByRole("status").filter({ hasText: "再公開を承認しました。" })).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    await owner.context().close();
    await manager.context().close();
  });

  test("モバイル幅でも横スクロールなしで、AD-11・AD-15 の操作を使える", async ({ browser, baseURL }) => {
    await setUserState("poc_staff", { profileState: "hidden" });
    const owner = await openAs(browser, baseURL!, "poc_staff");
    await owner.goto("/me/profile");
    await owner.getByRole("button", { name: "保存する" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "再公開の申請として審査されます。" })).toBeVisible();
    await owner.context().close();

    const page = await openAs(browser, baseURL!, "poc_s_mgr");
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/admin/profile-reviews");
    await expectNoHorizontalScroll(page);
    await page.getByRole("link", { name: "学校職員（サンプル）" }).click();
    await expect(page.getByRole("heading", { name: "学校職員（サンプル） の再公開申請" })).toBeInViewport();
    await expectNoHorizontalScroll(page);
    for (const name of ["承認する", "却下する"]) {
      const button = page.getByRole("button", { name });
      await button.scrollIntoViewIfNeeded();
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }

    await page.goto(`/admin/users/${await userIdOf("poc_s002")}`);
    await expectNoHorizontalScroll(page);
    await page.getByRole("textbox", { name: /非表示の理由/ }).fill("確認用の理由");
    await page.getByRole("button", { name: "プロフィールを非表示にする" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    for (const name of ["キャンセル", "非表示にする"]) {
      expect((await dialog.getByRole("button", { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    // 確定せずに閉じる。
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("公開中", { exact: true })).toBeVisible();
    await page.context().close();
  });
});
