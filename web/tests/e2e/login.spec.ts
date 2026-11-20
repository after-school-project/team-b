import { expect, test, type Page, type Route } from "@playwright/test";

const authenticationError =
  "ログインできませんでした。ログインIDとパスワードを確認し、時間をおいてもう一度お試しください。";
const processingError = "ログイン処理を完了できませんでした。時間をおいてもう一度お試しください。";
const logoutError = "ログアウトできませんでした。時間をおいてもう一度お試しください。";
const suspendedBody = '{"data":{"access":"suspended","publicReason":"学校から利用停止の案内があります。"}}';
const unauthenticatedBody = '{"error":{"code":"AUTH_REQUIRED"}}';

type MockResponse = { status: number; body: string };

async function submitValidCredentials(page: Page) {
  await page.getByLabel("ログインID").fill("poc_s001");
  await page.getByLabel("パスワード").fill("correct-horse-battery");
  await page.getByRole("button", { name: "ログイン" }).click();
}

/**
 * ホームへの移動要求を待つ。ホーム自体はサーバー側の認可で表示可否を判定し、
 * モックした認証では実セッションがないためログイン画面へ戻される。ここでは画面が戻り先へ移動したことだけを確認する。
 * 実セッションでホームまで表示できることは home.spec.ts で確認する（seed のパスワードを画面に入力しない形で行う）。
 */
function homeNavigation(page: Page) {
  return page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === "/");
}

/**
 * 認証成功と、認証後の利用状態APIをモックする。
 * 入口の表示時の確認（認証前）は 401 を返し、認証後は `me` を返す。
 */
async function mockSuccessfulSignIn(page: Page, me?: MockResponse) {
  let signedIn = false;
  await page.route("**/api/auth/sign-in/username", (route) => {
    signedIn = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"redirect":false,"user":{"id":"user-1"}}',
    });
  });
  if (me) {
    await page.route("**/api/v1/me", (route) =>
      signedIn
        ? route.fulfill({ status: me.status, contentType: "application/json", body: me.body })
        : route.fulfill({ status: 401, contentType: "application/json", body: unauthenticatedBody }),
    );
  }
}

test.beforeEach(async ({ page }) => {
  // 既定はセッションなし。各テストで後から登録した route が優先される。
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: unauthenticatedBody }),
  );
});

const contactNotice = "パスワードを忘れた場合やログインできない場合は、開発担当へ連絡してください。";

test("再発行の連絡先案内をフォームと停止時の案内の両方に表示する", async ({ page }) => {
  await mockSuccessfulSignIn(page, { status: 200, body: suspendedBody });
  await page.goto("/login");
  await expect(page.getByText(contactNotice)).toBeVisible();

  await submitValidCredentials(page);
  await expect(page.getByText("学校から利用停止の案内があります。")).toBeVisible();
  await expect(page.getByText(contactNotice)).toBeVisible();
});

test("未入力と形式違反を項目ごとに案内し、入力値を保つ", async ({ page }) => {
  await page.goto("/login");

  await expect(page.getByText("小文字英数字とアンダースコア、3〜30文字")).toHaveCount(0);
  await expect(page.getByText("12〜128文字")).toHaveCount(0);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByText("ログインIDを入力してください")).toBeVisible();
  await expect(page.getByText("パスワードを入力してください")).toBeVisible();

  await page.getByLabel("ログインID").fill("UPPER");
  await page.getByLabel("パスワード").fill("short");
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByText("ログインIDは小文字英数字とアンダースコアの3〜30文字で入力してください。")).toBeVisible();
  await expect(page.getByText("パスワードは12〜128文字で入力してください。")).toBeVisible();
  await expect(page.getByLabel("ログインID")).toHaveValue("UPPER");
});

for (const status of [401, 429]) {
  test(`${status}は認証情報の同一エラーを表示する`, async ({ page }) => {
    await page.route("**/api/auth/sign-in/username", (route) =>
      route.fulfill({ status, contentType: "application/json", body: '{"message":"sensitive SDK detail"}' }),
    );
    await page.goto("/login");
    await submitValidCredentials(page);

    await expect(page.getByRole("main").getByRole("alert")).toHaveText(authenticationError);
    await expect(page.getByText("sensitive SDK detail")).toHaveCount(0);
    await expect(page.getByLabel("ログインID")).toHaveValue("poc_s001");
  });
}

test("認証APIの通信障害は共通の処理エラーを表示する", async ({ page }) => {
  await page.route("**/api/auth/sign-in/username", (route) => route.abort());
  await page.goto("/login");
  await submitValidCredentials(page);

  await expect(page.getByRole("main").getByRole("alert")).toHaveText(processingError);
});

test("認証APIのサーバーエラーは共通の処理エラーを表示する", async ({ page }) => {
  await page.route("**/api/auth/sign-in/username", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"private server detail"}' }),
  );
  await page.goto("/login");
  await submitValidCredentials(page);

  await expect(page.getByRole("main").getByRole("alert")).toHaveText(processingError);
  await expect(page.getByText("private server detail")).toHaveCount(0);
});

for (const credentials of [
  { username: "abc", password: "p".repeat(12) },
  { username: "a".repeat(30), password: "p".repeat(128) },
]) {
  test(`ID ${credentials.username.length}文字・パスワード${credentials.password.length}文字の境界値を送信する`, async ({ page }) => {
    await page.route("**/api/auth/sign-in/username", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
    );
    await page.goto("/login");
    await page.getByLabel("ログインID").fill(credentials.username);
    await page.getByLabel("パスワード").fill(credentials.password);
    await page.getByRole("button", { name: "ログイン" }).click();

    await expect(page.getByRole("main").getByRole("alert")).toHaveText(authenticationError);
  });
}

test("送信中は二重送信を防ぎ、入力どおりの値だけを認証APIへ送る", async ({ page }) => {
  let requests = 0;
  let requestBody: unknown;
  let releaseResponse = () => {};
  const responseReleased = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route("**/api/auth/sign-in/username", async (route) => {
    requests += 1;
    requestBody = route.request().postDataJSON();
    await responseReleased;
    await route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
  });
  await page.goto("/login");
  await page.getByLabel("ログインID").fill("poc_s001");
  await page.getByLabel("パスワード").fill(" password 123 ");
  await page.getByRole("button", { name: "ログイン" }).click();

  const submitButton = page.getByRole("button", { name: "確認中..." });
  await expect(submitButton).toBeDisabled();
  // ボタンの無効化に頼らず、フォーム送信を直接再実行しても送信されないことを確認する。
  await page.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  releaseResponse();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(authenticationError);
  expect(requests).toBe(1);
  expect(requestBody).toEqual({ username: "poc_s001", password: " password 123 " });
});

for (const target of ["/", undefined, "/not-implemented", "//example.com", "/api/auth/sign-out", "/login"]) {
  test(`activeのとき戻り先 ${target ?? "(未指定)"} を安全に処理する`, async ({ page }) => {
    await mockSuccessfulSignIn(page, { status: 200, body: '{"data":{"access":"active"}}' });
    const query = target === undefined ? "" : `?returnTo=${encodeURIComponent(target)}`;
    await page.goto(`/login${query}`);
    const navigated = homeNavigation(page);
    await submitValidCredentials(page);

    await navigated;
  });
}

test("suspendedはpublicReasonとログアウトを表示し、ログアウト後にログイン入口へ戻る", async ({ page }) => {
  await mockSuccessfulSignIn(page, { status: 200, body: suspendedBody });
  let signOutBody: unknown;
  await page.route("**/api/auth/sign-out", async (route) => {
    signOutBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' });
  });
  await page.goto("/login");
  await submitValidCredentials(page);

  await expect(page.getByText("学校から利用停止の案内があります。")).toBeVisible();
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page).toHaveURL("/login");
  expect(signOutBody).toEqual({});
});

test("ACCOUNT_NOT_READYは利用準備中の案内を同じ入口に表示する", async ({ page }) => {
  await mockSuccessfulSignIn(page, {
    status: 403,
    body: '{"error":{"code":"ACCOUNT_NOT_READY","message":"private detail"}}',
  });
  await page.goto("/login");
  await submitValidCredentials(page);

  await expect(page.getByRole("main").getByRole("status")).toHaveText("このアカウントは利用準備中です。");
  await expect(page).toHaveURL("/login");
  await expect(page.getByText("private detail")).toHaveCount(0);
});

test("利用準備中の案内からログアウトしてフォームへ戻れる", async ({ page }) => {
  await mockSuccessfulSignIn(page, { status: 403, body: '{"error":{"code":"ACCOUNT_NOT_READY"}}' });
  let signOutRequests = 0;
  await page.route("**/api/auth/sign-out", async (route) => {
    signOutRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' });
  });
  await page.goto("/login");
  await submitValidCredentials(page);

  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page.getByLabel("ログインID")).toHaveValue("");
  await expect(page).toHaveURL("/login");
  expect(signOutRequests).toBe(1);
});

for (const me of [
  { name: "サーバーエラー", status: 503, body: '{"error":{"code":"TEMPORARILY_UNAVAILABLE"}}' },
  { name: "JSON以外の応答", status: 200, body: "<html></html>" },
  { name: "空のpublicReason", status: 200, body: '{"data":{"access":"suspended","publicReason":" "}}' },
  { name: "未知のaccess", status: 200, body: '{"data":{"access":"unknown"}}' },
]) {
  test(`利用状態APIの${me.name}ではセッションを破棄して処理エラーを表示する`, async ({ page }) => {
    await mockSuccessfulSignIn(page, me);
    let signOutRequests = 0;
    await page.route("**/api/auth/sign-out", async (route) => {
      signOutRequests += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' });
    });
    await page.goto("/login");
    await submitValidCredentials(page);

    await expect(page.getByRole("main").getByRole("alert")).toHaveText(processingError);
    await expect(page.getByLabel("ログインID")).toBeVisible();
    expect(signOutRequests).toBe(1);
  });
}

test("複数の入力エラーはフォーム上部にも件数を案内する", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "ログイン" }).click();

  await expect(page.getByText("2件の入力内容を確認してください。")).toBeVisible();
  await page.getByLabel("ログインID").fill("poc_s001");
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByText("2件の入力内容を確認してください。")).toHaveCount(0);
  await expect(page.getByText("パスワードを入力してください")).toBeVisible();
});

test("パスワードの表示・非表示を切り替えられる", async ({ page }) => {
  await page.goto("/login");
  const password = page.getByLabel("パスワード");
  await password.fill("correct-horse-battery");

  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "表示", exact: true }).click();
  await expect(password).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "非表示" }).click();
  await expect(password).toHaveAttribute("type", "password");
});

test("パスワードの文字数は認証サーバーと同じUTF-16単位で数える", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/auth/sign-in/username", (route) => {
    requests += 1;
    return route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
  });
  await page.goto("/login");
  await page.getByLabel("ログインID").fill("poc_s001");

  await page.getByLabel("パスワード").fill("😀".repeat(65));
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByText("パスワードは12〜128文字で入力してください。")).toBeVisible();
  expect(requests).toBe(0);

  await page.getByLabel("パスワード").fill("😀".repeat(64));
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(authenticationError);
  expect(requests).toBe(1);
});

test("利用状態APIの401では認証エラーとログインフォームを表示する", async ({ page }) => {
  await mockSuccessfulSignIn(page, { status: 401, body: unauthenticatedBody });
  await page.goto("/login");
  await submitValidCredentials(page);

  await expect(page.getByRole("main").getByRole("alert")).toHaveText(authenticationError);
  await expect(page.getByLabel("ログインID")).toBeVisible();
  await expect(page).toHaveURL("/login");
});

test.describe("JavaScriptが動かない状態", () => {
  test.use({ javaScriptEnabled: false });

  test("フォームを送信しても認証情報をURLに含めない", async ({ page }) => {
    // 送信先の応答は問わないため、ログイン画面への POST だけを遮断する。
    await page.route("**/login*", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>blocked</title>" })
        : route.fallback(),
    );
    await page.goto("/login");
    await page.getByLabel("ログインID").fill("poc_s001");
    await page.getByLabel("パスワード").fill("correct-horse-battery");

    const submitted = page.waitForRequest((request) => request.isNavigationRequest() && request.url().includes("/login"));
    await page.getByRole("button", { name: "ログイン" }).click();
    const request = await submitted;

    expect(request.method()).toBe("POST");
    for (const url of [request.url(), page.url()]) {
      expect(url).not.toContain("poc_s001");
      expect(url).not.toContain("correct-horse-battery");
      expect(url).not.toContain("password");
    }
  });
});

test("停止案内を再読み込みしても、停止理由とログアウトを表示する", async ({ page }) => {
  await mockSuccessfulSignIn(page, { status: 200, body: suspendedBody });
  let signOutRequests = 0;
  await page.route("**/api/auth/sign-out", async (route) => {
    signOutRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' });
  });
  await page.goto("/login");
  await submitValidCredentials(page);
  await expect(page.getByText("学校から利用停止の案内があります。")).toBeVisible();

  // 再読み込み後もセッションが残っている間は、利用状態APIが停止中を返す。
  await page.reload();
  await expect(page.getByRole("main").getByRole("status")).toHaveText("このアカウントは利用停止中です。");
  await expect(page.getByText("学校から利用停止の案内があります。")).toBeVisible();
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page.getByLabel("ログインID")).toBeVisible();
  expect(signOutRequests).toBe(1);
});

test("既存セッションが利用準備中のときは、入口の表示時に案内とログアウトを表示する", async ({ page }) => {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({ status: 403, contentType: "application/json", body: '{"error":{"code":"ACCOUNT_NOT_READY"}}' }),
  );
  await page.goto("/login");

  await expect(page.getByRole("main").getByRole("status")).toHaveText("このアカウントは利用準備中です。");
  await expect(page.getByRole("button", { name: "ログアウト" })).toBeVisible();
});

test("既存セッションが有効なときは、入口の表示時に戻り先へ移動する", async ({ page }) => {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"data":{"access":"active"}}' }),
  );
  const navigated = homeNavigation(page);
  await page.goto("/login");

  await navigated;
});

for (const signOutFailure of [
  {
    name: "非2xx応答",
    respond: (route: Route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  },
  { name: "通信失敗", respond: (route: Route) => route.abort() },
]) {
  test(`自動ログアウトの${signOutFailure.name}では、エラーとログアウトの再試行を表示する`, async ({ page }) => {
    await mockSuccessfulSignIn(page, { status: 503, body: '{"error":{"code":"TEMPORARILY_UNAVAILABLE"}}' });
    let signOutRequests = 0;
    await page.route("**/api/auth/sign-out", async (route) => {
      signOutRequests += 1;
      if (signOutRequests === 1) return signOutFailure.respond(route);
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' });
    });
    await page.goto("/login");
    await submitValidCredentials(page);

    await expect(page.getByRole("main").getByRole("alert")).toHaveText(logoutError);
    await expect(page.getByLabel("ログインID")).toHaveCount(0);

    // 再試行で失効を確認できたらログインフォームへ戻る。
    await page.getByRole("button", { name: "ログアウト" }).click();
    await expect(page.getByLabel("ログインID")).toBeVisible();
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    expect(signOutRequests).toBe(2);
  });
}

test("自動ログアウトに失敗したあと再読み込みしても、利用状態を確認できなければログアウトを試せる", async ({ page }) => {
  // 認証後の利用状態APIは、再読み込み後も 503 を返し続ける。
  await mockSuccessfulSignIn(page, { status: 503, body: '{"error":{"code":"TEMPORARILY_UNAVAILABLE"}}' });
  let signOutRequests = 0;
  await page.route("**/api/auth/sign-out", async (route) => {
    signOutRequests += 1;
    if (signOutRequests === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' });
  });
  await page.goto("/login");
  await submitValidCredentials(page);
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(logoutError);

  await page.reload();
  await expect(page.getByRole("main").getByRole("status")).toHaveText("利用状態を確認できませんでした。");
  await expect(page.getByLabel("ログインID")).toBeVisible();
  await page.getByRole("button", { name: "ログアウト" }).click();

  await expect(page.getByRole("main").getByRole("status")).toHaveCount(0);
  await expect(page.getByLabel("ログインID")).toBeVisible();
  expect(signOutRequests).toBe(2);
});

test("利用状態を確認できない案内からのログアウトに失敗したら、エラーと案内を残す", async ({ page }) => {
  await page.route("**/api/v1/me", (route) => route.abort());
  await page.route("**/api/auth/sign-out", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await page.goto("/login");

  await expect(page.getByRole("main").getByRole("status")).toHaveText("利用状態を確認できませんでした。");
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(logoutError);
  await expect(page.getByRole("button", { name: "ログアウト" })).toBeEnabled();
});

for (const status of [401, 429]) {
  test(`利用状態の確認中に送信した認証が${status}で失敗したら、確認を再開して停止案内を表示する`, async ({ page }) => {
    let meRequests = 0;
    let releaseFirstCheck = () => {};
    const firstCheckReleased = new Promise<void>((resolve) => {
      releaseFirstCheck = resolve;
    });
    await page.route("**/api/v1/me", async (route) => {
      meRequests += 1;
      // 入口表示時の確認は、フォームを送信するまで応答しない。
      if (meRequests === 1) await firstCheckReleased;
      await route.fulfill({ status: 200, contentType: "application/json", body: suspendedBody }).catch(() => {});
    });
    let signInRequests = 0;
    await page.route("**/api/auth/sign-in/username", (route) => {
      signInRequests += 1;
      return route.fulfill({ status, contentType: "application/json", body: "{}" });
    });
    const firstCheck = page.waitForRequest("**/api/v1/me");
    await page.goto("/login");
    await firstCheck;

    await submitValidCredentials(page);
    await expect(page.getByRole("main").getByRole("status")).toHaveText("このアカウントは利用停止中です。");
    await expect(page.getByText("学校から利用停止の案内があります。")).toBeVisible();
    await expect(page.getByRole("button", { name: "ログアウト" })).toBeVisible();
    expect(signInRequests).toBe(1);
    expect(meRequests).toBe(2);
    releaseFirstCheck();
  });
}

test("ログアウトの処理中はログインを送信せず、完了後に送信できる", async ({ page }) => {
  await page.route("**/api/v1/me", (route) => route.abort());
  let releaseSignOut = () => {};
  const signOutReleased = new Promise<void>((resolve) => {
    releaseSignOut = resolve;
  });
  await page.route("**/api/auth/sign-out", async (route) => {
    await signOutReleased;
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' });
  });
  let signInRequests = 0;
  await page.route("**/api/auth/sign-in/username", (route) => {
    signInRequests += 1;
    return route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
  });
  await page.goto("/login");
  await expect(page.getByRole("main").getByRole("status")).toHaveText("利用状態を確認できませんでした。");
  await page.getByLabel("ログインID").fill("poc_s001");
  await page.getByLabel("パスワード").fill("correct-horse-battery");

  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page.getByRole("button", { name: "ログアウト中..." })).toBeDisabled();
  await expect(page.getByRole("button", { name: "ログイン", exact: true })).toBeDisabled();
  await expect(page.getByLabel("ログインID")).toBeDisabled();
  await expect(page.getByLabel("パスワード")).toBeDisabled();
  // ボタンの無効化に頼らず、フォーム送信を直接実行しても認証APIへ送らないことを確認する。
  await page.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(signInRequests).toBe(0);

  releaseSignOut();
  await expect(page.getByRole("main").getByRole("status")).toHaveCount(0);
  await expect(page.getByLabel("ログインID")).toBeEnabled();
  expect(signInRequests).toBe(0);

  // ログアウト完了後は通常どおり送信できる。
  await submitValidCredentials(page);
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(authenticationError);
  expect(signInRequests).toBe(1);
});

test("ログアウト後はパスワードの表示設定を初期化する", async ({ page }) => {
  await page.route("**/api/v1/me", (route) => route.abort());
  await page.route("**/api/auth/sign-out", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' }),
  );
  await page.goto("/login");
  await expect(page.getByRole("main").getByRole("status")).toHaveText("利用状態を確認できませんでした。");
  const password = page.getByLabel("パスワード");
  await password.fill("correct-horse-battery");
  await page.getByRole("button", { name: "表示", exact: true }).click();
  await expect(password).toHaveAttribute("type", "text");

  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page.getByRole("main").getByRole("status")).toHaveCount(0);
  await expect(password).toHaveValue("");
  await expect(password).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "表示", exact: true })).toBeVisible();
});
