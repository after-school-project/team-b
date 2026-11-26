import { expect, test, type Page, type Route } from "@playwright/test";
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

/**
 * ページがバックフォワードキャッシュから復元されたときのイベントを送る。Playwright の Chromium は BFCache を無効にして起動し、
 * 無効化を外しても保護画面は実際には復元されなかった（2026-11-26 にローカルで確認）ため、復元時の `pageshow` を直接送って分岐を確認する。
 */
async function showFromBackForwardCache(page: Page) {
  // 共通ナビゲーションが操作できる（復元時のリスナーを登録済みの）状態になってから送る。
  const accountMenu = page.getByRole("button", { name: "マイメニュー" });
  await expect(async () => {
    if (await accountMenu.getAttribute("aria-expanded") === "false") await accountMenu.click();
    await expect(accountMenu).toHaveAttribute("aria-expanded", "true", { timeout: 500 });
  }).toPass({ timeout: 10000 });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
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
  await expect(page.getByRole("navigation", { name: "主要メニュー" })
    .getByRole("link", { name: "お知らせ", exact: true })).toHaveAttribute("href", "/notices");

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

for (const { layout, viewport, menuName, firstLinkName } of [
  {
    layout: "横向き",
    viewport: { width: 844, height: 390 },
    menuName: "マイメニュー",
    firstLinkName: "マイプロフィール",
  },
  {
    layout: "縦向き",
    viewport: { width: 375, height: 812 },
    menuName: "メニュー",
    firstLinkName: "ホーム",
  },
]) {
  test(`${layout}のメニューでログアウト失敗後に通常のTab順序を保ち、再試行できる`, async ({ page, baseURL }) => {
    await page.setViewportSize(viewport);
    await signIn(page, baseURL!, "poc_s001");
    await page.goto("/");
    let requests = 0;
    await page.route("**/api/auth/sign-out", async (route) => {
      requests += 1;
      if (requests === 1) {
        await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
        return;
      }
      await route.fulfill({ response: await fetchSignOutAtAuthOrigin(route) });
    });

    const menu = page.getByRole("button", { name: menuName, exact: true });
    const firstLink = page.getByRole("link", { name: firstLinkName, exact: true });
    const signOut = page.getByRole("button", { name: "ログアウト", exact: true });
    await menu.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(firstLink).toBeFocused();
    await signOut.focus();
    await page.keyboard.press("Enter");
    const error = page.getByRole("alert").filter({
      hasText: "ログアウトできませんでした。時間をおいてもう一度お試しください。",
    });
    await expect(error).toBeVisible();
    await expect(signOut).toBeEnabled();
    await expect(signOut).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await page.keyboard.press("Enter");
    // 閉じる前の失敗を、開き直したメニューに残さない。
    await expect(error).toHaveCount(0);
    await page.keyboard.press("Tab");
    await expect(firstLink).toBeFocused();

    // メニュー内をスクロールして、タップできる位置まで再試行ボタンを表示する。
    await firstLink.hover();
    await page.mouse.wheel(0, 400);
    await expect(signOut).toBeInViewport({ ratio: 1 });
    await signOut.click();
    await expect(page).toHaveURL(/\/login$/);
    expect(requests).toBe(2);
  });
}

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
  await signOut.focus();
  await page.keyboard.press("Enter");
  const busyButton = page.getByRole("button", { name: "ログアウト中..." });
  await expect(busyButton).toBeDisabled();
  await expect(busyButton).toBeFocused();
  await expect.poll(() => requests).toBe(1);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  releaseSignOut();
  await expect(page).toHaveURL(/\/login$/);
  expect(requests).toBe(1);
});

test("ログアウト処理中に画面を移動しても、処理中の表示と失敗時のエラーを引き継ぐ", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/");
  let releaseSignOut: () => void = () => {};
  const pending = new Promise<void>((resolve) => { releaseSignOut = resolve; });
  let requests = 0;
  await page.route("**/api/auth/sign-out", async (route) => {
    requests += 1;
    await pending;
    if (requests === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({ response: await fetchSignOutAtAuthOrigin(route) });
  });

  const accountMenu = page.getByRole("button", { name: "マイメニュー" });
  await accountMenu.click();
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await page.getByRole("link", { name: "マイプロフィール", exact: true }).click();
  await expect(page).toHaveURL(/\/me\/profile$/);

  await accountMenu.click();
  const busyButton = page.getByRole("button", { name: "ログアウト中..." });
  await expect(busyButton).toBeDisabled();
  await busyButton.focus();
  await page.keyboard.press("Enter");
  releaseSignOut();
  await expect(page.getByRole("alert").filter({
    hasText: "ログアウトできませんでした。時間をおいてもう一度お試しください。",
  })).toBeVisible();
  const signOut = page.getByRole("button", { name: "ログアウト", exact: true });
  await expect(signOut).toBeEnabled();
  expect(requests).toBe(1);

  await signOut.click();
  await expect(page).toHaveURL(/\/login$/);
  expect(requests).toBe(2);
});

test("通信エラーでログアウトできなかった場合もエラーを表示し、再試行できる", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/");
  let requests = 0;
  await page.route("**/api/auth/sign-out", async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({ response: await fetchSignOutAtAuthOrigin(route) });
  });

  await page.getByRole("button", { name: "マイメニュー" }).click();
  const signOut = page.getByRole("button", { name: "ログアウト", exact: true });
  await signOut.click();
  await expect(page.getByRole("alert").filter({
    hasText: "ログアウトできませんでした。時間をおいてもう一度お試しください。",
  })).toBeVisible();
  await expect(signOut).toBeEnabled();

  await signOut.click();
  await expect(page).toHaveURL(/\/login$/);
  expect(requests).toBe(2);
});

test("ログアウト後にブラウザーの戻る操作をしても、保護画面を表示しない", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/");
  await page.getByRole("navigation", { name: "主要メニュー" }).getByRole("link", { name: "Q&A", exact: true }).click();
  await expect(page).toHaveURL(/\/questions$/);
  await page.route("**/api/auth/sign-out", async (route) => {
    await route.fulfill({ response: await fetchSignOutAtAuthOrigin(route) });
  });
  await page.getByRole("button", { name: "マイメニュー" }).click();
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { level: 1, name: "ログイン" })).toBeVisible();
  await expect(page.getByRole("button", { name: "マイメニュー" })).toHaveCount(0);
});

test("移動先の画面が表示される前にログアウトが失敗しても、移動先のメニューにエラーを表示し、再試行できる", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  let releaseSignOut: () => void = () => {};
  const signOutGate = new Promise<void>((resolve) => { releaseSignOut = resolve; });
  let releaseProfile: () => void = () => {};
  const profileGate = new Promise<void>((resolve) => { releaseProfile = resolve; });
  let requests = 0;
  await page.route("**/api/auth/sign-out", async (route) => {
    requests += 1;
    if (requests === 1) {
      await signOutGate;
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({ response: await fetchSignOutAtAuthOrigin(route) });
  });
  // 移動先の画面の読み込み（先読みを含む）を止め、ログアウトの失敗を移動先の表示より先に返す。
  await page.route("**/me/profile**", async (route) => {
    await profileGate;
    await route.continue();
  });
  await page.goto("/");

  const accountMenu = page.getByRole("button", { name: "マイメニュー" });
  await accountMenu.click();
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await page.getByRole("link", { name: "マイプロフィール", exact: true }).click();
  const failed = page.waitForResponse((response) => response.url().endsWith("/api/auth/sign-out"));
  releaseSignOut();
  expect((await failed).status()).toBe(503);
  releaseProfile();
  await expect(page).toHaveURL(/\/me\/profile$/);

  await accountMenu.click();
  await expect(page.getByRole("alert").filter({
    hasText: "ログアウトできませんでした。時間をおいてもう一度お試しください。",
  })).toBeVisible();
  const signOut = page.getByRole("button", { name: "ログアウト", exact: true });
  await expect(signOut).toBeEnabled();
  await signOut.click();
  await expect(page).toHaveURL(/\/login$/);
  expect(requests).toBe(2);
});

test("移動先の画面を描画した直後、状態の購読を始める前にログアウトが失敗しても、エラーを表示し再試行できる", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  // 1回目のログアウト要求は、移動先の画面が DOM に反映された直後（React の effect より前のマイクロタスク）に 503 で応答する。
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let intercepted = false;
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (intercepted || new URL(url, location.href).pathname !== "/api/auth/sign-out") return originalFetch(input, init);
      intercepted = true;
      return new Promise<Response>((resolve) => {
        const observer = new MutationObserver(() => {
          if (![...document.querySelectorAll("h1")].some((heading) => heading.textContent === "マイプロフィール")) return;
          observer.disconnect();
          resolve(new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } }));
        });
        observer.observe(document, { childList: true, subtree: true });
      });
    };
  });
  let requests = 0;
  await page.route("**/api/auth/sign-out", async (route) => {
    requests += 1;
    await route.fulfill({ response: await fetchSignOutAtAuthOrigin(route) });
  });
  await page.goto("/");

  const accountMenu = page.getByRole("button", { name: "マイメニュー" });
  await accountMenu.click();
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page.getByRole("button", { name: "ログアウト中..." })).toBeVisible();
  await page.getByRole("link", { name: "マイプロフィール", exact: true }).click();
  await expect(page).toHaveURL(/\/me\/profile$/);
  await expect(page.getByRole("heading", { level: 1, name: "マイプロフィール" })).toBeVisible();

  await accountMenu.click();
  await expect(page.getByRole("alert").filter({
    hasText: "ログアウトできませんでした。時間をおいてもう一度お試しください。",
  })).toBeVisible();
  const signOut = page.getByRole("button", { name: "ログアウト", exact: true });
  await expect(signOut).toBeEnabled();
  expect(requests).toBe(0);
  await signOut.click();
  await expect(page).toHaveURL(/\/login$/);
  expect(requests).toBe(1);
});

test("ログアウトしたページがキャッシュから復元されたら、再読み込みしてログイン画面へ移す", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/");
  await page.route("**/api/auth/sign-out", async (route) => {
    await route.fulfill({ response: await fetchSignOutAtAuthOrigin(route) });
  });
  // 復元される前の状態を作るため、ログアウト成功後のログイン画面への移動を取り消し、ログアウトしたページに留める。
  await page.route("**/login", async (route) => {
    if (route.request().isNavigationRequest()) await route.abort("aborted");
    else await route.continue();
  });
  const leaving = page.waitForEvent("requestfailed", (request) => new URL(request.url()).pathname === "/login");

  await page.getByRole("button", { name: "マイメニュー" }).click();
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await leaving;
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "ログアウト中..." })).toBeVisible();

  await page.unroute("**/login");
  await showFromBackForwardCache(page);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { level: 1, name: "ログイン" })).toBeVisible();
});

test("別のページでログアウトした後に保護画面がキャッシュから復元されたら、ログイン画面へ移す", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/");
  const response = await page.request.post("/api/auth/sign-out", {
    headers: { Origin: canonicalOrigin ?? new URL(baseURL!).origin },
    data: {},
  });
  expect(response.ok()).toBe(true);

  await showFromBackForwardCache(page);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { level: 1, name: "ログイン" })).toBeVisible();
});

test("ログイン中に保護画面がキャッシュから復元されても、再読み込みせず表示を保つ", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, "poc_s001");
  await page.goto("/");
  await page.evaluate(() => { (window as Window & { restoreMarker?: boolean }).restoreMarker = true; });

  const checked = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/me");
  await showFromBackForwardCache(page);
  expect((await checked).status()).toBe(200);
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(() => (window as Window & { restoreMarker?: boolean }).restoreMarker)).toBe(true);
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
