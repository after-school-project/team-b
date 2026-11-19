import { expect, test, type Page } from "@playwright/test";

const authenticationError =
  "ログインできませんでした。ログインIDとパスワードを確認し、時間をおいてもう一度お試しください。";
const processingError = "ログイン処理を完了できませんでした。時間をおいてもう一度お試しください。";

async function submitValidCredentials(page: Page) {
  await page.getByLabel("ログインID").fill("poc_s001");
  await page.getByLabel("パスワード").fill("correct-horse-battery");
  await page.getByRole("button", { name: "ログイン" }).click();
}

async function mockSuccessfulSignIn(page: Page) {
  await page.route("**/api/auth/sign-in/username", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"redirect":false,"user":{"id":"user-1"}}' }),
  );
}

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

    await expect(page.getByRole("alert")).toHaveText(authenticationError);
    await expect(page.getByText("sensitive SDK detail")).toHaveCount(0);
    await expect(page.getByLabel("ログインID")).toHaveValue("poc_s001");
  });
}

test("認証APIの通信障害は共通の処理エラーを表示する", async ({ page }) => {
  await page.route("**/api/auth/sign-in/username", (route) => route.abort());
  await page.goto("/login");
  await submitValidCredentials(page);

  await expect(page.getByRole("alert")).toHaveText(processingError);
});

test("認証APIのサーバーエラーは共通の処理エラーを表示する", async ({ page }) => {
  await page.route("**/api/auth/sign-in/username", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"private server detail"}' }),
  );
  await page.goto("/login");
  await submitValidCredentials(page);

  await expect(page.getByRole("alert")).toHaveText(processingError);
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

    await expect(page.getByRole("alert")).toHaveText(authenticationError);
  });
}

test("送信中は二重送信を防ぎ、入力どおりの値だけを認証APIへ送る", async ({ page }) => {
  let requests = 0;
  let requestBody: unknown;
  await page.route("**/api/auth/sign-in/username", async (route) => {
    requests += 1;
    requestBody = route.request().postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
  });
  await page.goto("/login");
  await page.getByLabel("ログインID").fill("poc_s001");
  await page.getByLabel("パスワード").fill(" password 123 ");
  await page.getByRole("button", { name: "ログイン" }).click();

  const submitButton = page.getByRole("button", { name: "確認中..." });
  await expect(submitButton).toBeDisabled();
  await submitButton.evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole("alert")).toHaveText(authenticationError);
  expect(requests).toBe(1);
  expect(requestBody).toEqual({ username: "poc_s001", password: " password 123 " });
});

for (const target of ["/", undefined, "/not-implemented", "//example.com", "/api/auth/sign-out", "/login"]) {
  test(`activeのとき戻り先 ${target ?? "(未指定)"} を安全に処理する`, async ({ page }) => {
    await mockSuccessfulSignIn(page);
    await page.route("**/api/v1/me", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"data":{"access":"active"}}' }),
    );
    const query = target === undefined ? "" : `?returnTo=${encodeURIComponent(target)}`;
    await page.goto(`/login${query}`);
    await submitValidCredentials(page);

    await expect(page).toHaveURL("/");
  });
}

test("suspendedはpublicReasonとログアウトを表示し、ログアウト後にログイン入口へ戻る", async ({ page }) => {
  await mockSuccessfulSignIn(page);
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"data":{"access":"suspended","publicReason":"学校から利用停止の案内があります。"}}',
    }),
  );
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
  await mockSuccessfulSignIn(page);
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: '{"error":{"code":"ACCOUNT_NOT_READY","message":"private detail"}}',
    }),
  );
  await page.goto("/login");
  await submitValidCredentials(page);

  await expect(page.getByRole("status")).toHaveText("このアカウントは利用準備中です。");
  await expect(page).toHaveURL("/login");
  await expect(page.getByText("private detail")).toHaveCount(0);
});

test("利用状態APIの401では認証エラーとログインフォームを表示する", async ({ page }) => {
  await mockSuccessfulSignIn(page);
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: '{"error":{"code":"AUTH_REQUIRED"}}' }),
  );
  await page.goto("/login");
  await submitValidCredentials(page);

  await expect(page.getByRole("alert")).toHaveText(authenticationError);
  await expect(page.getByLabel("ログインID")).toBeVisible();
  await expect(page).toHaveURL("/login");
});
