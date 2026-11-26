import { expect, test, type Route } from "@playwright/test";
import { canonicalOrigin, signIn } from "./session";

/**
 * 実セッションでホームへ入れることを確認する。モックせず、本番ビルドの認証・利用状態API・ホームの認可を通す。
 * 準備手順は docs/development/quality-and-poc.md の「ホストでのE2E」を参照する。
 *
 * seed のパスワードはトレース・スクリーンショット・エラーメッセージ・失敗時のページスナップショットに残さない。
 * そのため画面の入力欄には入力せず、ブラウザーと Cookie を共有する要求コンテキストからサインインし、
 * トレースなどの記録をこのファイルでは無効にする。画面での入力と送信は login.spec.ts で確認する。
 */
test.use({ trace: "off", screenshot: "off", video: "off" });

async function fetchSignOutAtAuthOrigin(route: Route) {
  return route.fetch({
    headers: {
      ...await route.request().allHeaders(),
      origin: canonicalOrigin ?? new URL(route.request().url()).origin,
    },
  });
}

test("利用中の利用者は実セッションでホームを表示し、再読み込み後も表示を保つ", async ({ page, baseURL }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/login");

  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/");
  await expect(page).toHaveURL("/");
  await expect(page.getByText("ただいま準備中です。")).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL("/");
  await expect(page.getByText("ただいま準備中です。")).toBeVisible();
});

test("ログイン画面は有効なセッションを戻り先へ送り、クエリーを保ったままホームを表示する", async ({ page, baseURL }) => {
  await page.goto("/?tab=home");
  await expect(page).toHaveURL("/login?returnTo=%2F%3Ftab%3Dhome");

  await signIn(page, baseURL!, "poc_a001");
  await page.reload();
  await expect(page).toHaveURL("/?tab=home");
  await expect(page.getByText("ただいま準備中です。")).toBeVisible();
});

test("ホームに共通レイアウトを表示し、本人メニューに自分の公開表示名を出す。一般利用者には管理導線を出さない", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "ホーム" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主要メニュー" }).getByRole("link", { name: "ホーム" }))
    .toHaveAttribute("aria-current", "page");
  // 未実装の画面への導線はリンクにしない。
  await expect(page.getByRole("link", { name: /お知らせ/ })).toHaveCount(0);

  const accountButton = page.getByRole("button", { name: "マイメニュー" });
  await accountButton.click();
  await expect(accountButton).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText(/^ログイン中\s*はる$/).filter({ visible: true })).toHaveCount(1);
  await expect(page.getByText("管理エリアへ")).toHaveCount(0);
});

for (const username of ["poc_s001", "poc_a001", "poc_staff", "poc_school"]) {
  test(`${username} はマイメニューからログアウトし、旧Cookieを使えない`, async ({ page, baseURL }) => {
    await signIn(page, baseURL!, username);
    await page.goto("/");
    await page.getByRole("button", { name: "マイメニュー" }).click();
    const signOut = page.getByRole("button", { name: "ログアウト" });
    await expect(signOut).toBeVisible();
    const sessionCookie = (await page.context().cookies(baseURL))
      .find(({ name }) => name.endsWith("better-auth.session_token"));
    expect(sessionCookie).toBeDefined();

    await page.route("**/api/auth/sign-out", async (route) => {
      await route.fulfill({ response: await fetchSignOutAtAuthOrigin(route) });
    });
    await signOut.click();
    await expect(page).toHaveURL(/\/login$/);

    const oldCookie = `${sessionCookie!.name}=${sessionCookie!.value}`;
    const me = await page.request.get("/api/v1/me", { headers: { Cookie: oldCookie } });
    expect(me.status()).toBe(401);

    await page.setExtraHTTPHeaders({ Cookie: oldCookie });
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { level: 1, name: "ログイン" })).toBeVisible();
  });
}

test("スマートフォンのマイメニューでキーボードからログアウトできる", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, baseURL!, "poc_a001");
  await page.goto("/");
  const menuButton = page.getByRole("button", { name: "メニュー", exact: true });
  await menuButton.focus();
  await page.keyboard.press("Enter");

  const signOut = page.getByRole("button", { name: "ログアウト" });
  await expect(signOut).toBeVisible();
  await page.route("**/api/auth/sign-out", async (route) => {
    await route.fulfill({ response: await fetchSignOutAtAuthOrigin(route) });
  });
  await signOut.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/login$/);
});

test("ログアウト失敗時はエラーを表示し、再試行できる", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/");
  await page.getByRole("button", { name: "マイメニュー" }).click();
  let requests = 0;
  await page.route("**/api/auth/sign-out", async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({ response: await fetchSignOutAtAuthOrigin(route) });
  });
  const signOut = page.getByRole("button", { name: "ログアウト" });
  await signOut.click();
  const error = page.getByText("ログアウトできませんでした。時間をおいてもう一度お試しください。", { exact: true })
    .filter({ visible: true });
  await expect(error).toHaveAttribute("role", "alert");
  await expect(signOut).toBeEnabled();

  await signOut.click();
  await expect(page).toHaveURL(/\/login$/);
  expect(requests).toBe(2);
});

test("ログアウト処理中はボタンを無効化し、要求を一度だけ送る", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/");
  await page.getByRole("button", { name: "マイメニュー" }).click();
  let releaseSignOut: () => void = () => {};
  const pending = new Promise<void>((resolve) => { releaseSignOut = resolve; });
  let requests = 0;
  await page.route("**/api/auth/sign-out", async (route) => {
    requests += 1;
    await pending;
    await route.fulfill({ response: await fetchSignOutAtAuthOrigin(route) });
  });

  const signOut = page.getByRole("button", { name: "ログアウト" });
  await signOut.click();
  const busyButton = page.getByRole("button", { name: "ログアウト中..." });
  await expect(busyButton).toBeDisabled();
  expect(requests).toBe(1);
  releaseSignOut();
  await expect(page).toHaveURL(/\/login$/);
  expect(requests).toBe(1);
});

test("学校管理者には管理導線を表示する（管理エリアの実装前は準備中）", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_school");
  await page.goto("/");
  await expect(page.getByText("管理エリアへ")).toBeVisible();
  await expect(page.getByRole("link", { name: /管理エリアへ/ })).toHaveCount(0);
});

test("モバイル幅でもキーボードだけでメニューを開閉し、主要導線と管理導線を使える", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, baseURL!, "poc_s_mgr");
  await page.goto("/");

  const menuButton = page.getByRole("button", { name: "メニュー", exact: true });
  await expect(menuButton).toBeVisible();
  await expect(page.getByRole("link", { name: "ホーム" })).toBeHidden();

  await menuButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "閉じる" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: "ホーム" })).toBeVisible();
  await expect(page.getByText("管理エリアへ")).toBeVisible();
  await expect(page.getByText(/^ログイン中\s*在校生アプリ管理者$/).filter({ visible: true })).toHaveCount(1);

  // 開いたメニュー内のリンクへ Tab で移動でき、Escape で閉じてボタンへ戻る。
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "ホーム" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
  await expect(menuButton).toBeFocused();
});

test("画面の高さが低いモバイルでも、開いたメニュー内だけをスクロールし、閉じるボタンを表示したまま全項目を確認できる", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 500 });
  await signIn(page, baseURL!, "poc_school");
  await page.goto("/");

  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  const closeButton = page.getByRole("button", { name: "閉じる" });
  await expect(closeButton).toBeInViewport();
  const header = await page.locator("header").boundingBox();
  expect(header!.height).toBeLessThanOrEqual(500);

  // メニューの最後の項目（管理導線）までメニュー内でスクロールしても、閉じるボタンは画面内に残る。
  const adminItem = page.getByText("管理エリアへ");
  await adminItem.scrollIntoViewIfNeeded();
  await expect(adminItem).toBeInViewport();
  await expect(closeButton).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await closeButton.click();
  await expect(page.getByRole("heading", { level: 1, name: "ホーム" })).toBeInViewport();
});

test("停止中の利用者はホームを表示せず、ログイン画面の停止案内に留まる", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_suspended");
  await page.goto("/");
  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("button", { name: "ログアウト" })).toBeVisible();
  await expect(page.getByText("ただいま準備中です。")).toHaveCount(0);
});
