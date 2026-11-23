import { describe, expect, it } from "vitest";
import { implementedScreenRoutes, loginPathFor, matchesScreenRoute, resolveReturnTo } from "../../src/auth/return-to";

describe("ログイン後の戻り先", () => {
  it.each([undefined, null, "", "/", "/?tab=home"])("実装済みのホームを許可する: %s", (value) => {
    expect(resolveReturnTo(value)).toBe(typeof value === "string" && value.startsWith("/") ? value : "/");
  });

  it.each([
    "https://example.com/",
    "//example.com/",
    "/login",
    "/login?returnTo=/",
    "/api/auth/sign-out",
    "/questions",
    "/\\example.com",
    "/%2F%2Fexample.com",
    "javascript:alert(1)",
    ["//example.com"],
  ])("許可外の戻り先 %s をホームにする", (value) => {
    expect(resolveReturnTo(value)).toBe("/");
  });
});

describe("可変パスを含む画面のルート", () => {
  const routes = ["/", "/questions/[questionId]", "/users/[userId]", "/me/events/[eventId]/edit"];
  const questionId = "0b6f2c1e-5d4a-4c3b-9a8f-7e6d5c4b3a21";

  it.each([
    [`/questions/${questionId}`, `/questions/${questionId}`],
    [`/questions/${questionId.toUpperCase()}`, `/questions/${questionId.toUpperCase()}`],
    [`/questions/${questionId}?tab=answers#a1`, `/questions/${questionId}?tab=answers#a1`],
    ["/users/abcDEF_123-x", "/users/abcDEF_123-x"],
    [`/me/events/${questionId}/edit`, `/me/events/${questionId}/edit`],
  ])("許可したルートに一致する %s を戻り先にする", (value, expected) => {
    expect(resolveReturnTo(value, routes)).toBe(expected);
  });

  it.each([
    "/questions/new",
    "/questions/not-a-uuid",
    `/questions/${questionId}/`,
    `/questions/${questionId}/edit`,
    "/questions",
    "/users/a%2Fb",
    "/users/a.b",
    "/users/",
    `/me/events/${questionId}`,
    `//questions/${questionId}`,
  ])("ルートに一致しない %s はホームにする", (value) => {
    expect(resolveReturnTo(value, routes)).toBe("/");
  });

  it("許可したルートだけをログイン画面のクエリーに付ける", () => {
    expect(loginPathFor(`/questions/${questionId}`, routes))
      .toBe(`/login?returnTo=${encodeURIComponent(`/questions/${questionId}`)}`);
    expect(loginPathFor("/questions/new", routes)).toBe("/login");
  });

  it("実装済みの画面に含まれないルートは、既定では戻り先にしない", () => {
    expect(implementedScreenRoutes).toEqual(["/"]);
    expect(resolveReturnTo(`/questions/${questionId}`)).toBe("/");
  });

  it("未定義のパラメーター名を含むルートは設定の誤りとして扱う", () => {
    expect(() => matchesScreenRoute("/x/1", ["/x/[unknownId]"])).toThrow("未定義のルートパラメーター");
  });

  it("ルート定義の誤記は、正常な戻り先の判定でも吸収せずにエラーにする", () => {
    const typo = ["/", "/questions/[questionID]"];
    expect(() => resolveReturnTo("/?tab=home", typo)).toThrow("未定義のルートパラメーター");
    expect(() => resolveReturnTo("https://example.com/", typo)).toThrow("未定義のルートパラメーター");
    expect(() => loginPathFor("/?tab=home", typo)).toThrow("未定義のルートパラメーター");
  });
});

describe("戻り先付きのログイン画面URL", () => {
  it("許可した戻り先だけをクエリーに付ける", () => {
    expect(loginPathFor("/?tab=home")).toBe("/login?returnTo=%2F%3Ftab%3Dhome");
  });

  it.each([undefined, "/", "//example.com", "/questions"])("既定・許可外の戻り先 %s は付けない", (value) => {
    expect(loginPathFor(value)).toBe("/login");
  });
});
