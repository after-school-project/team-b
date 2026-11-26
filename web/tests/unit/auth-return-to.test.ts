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
    "/notices",
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
    expect(implementedScreenRoutes).toEqual([
      "/", "/me/profile", "/users/[userId]", "/alumni", "/questions", "/questions/[questionId]",
      "/admin/users/[userId]", "/admin/profile-reviews", "/admin/graduation",
      "/notifications",
    ]);
    expect(resolveReturnTo(`/events/${questionId}`)).toBe("/");
    expect(resolveReturnTo("/questions/new")).toBe("/");
  });

  it("実装済みの可変パスの画面（公開プロフィール）は、既定の許可で戻り先にする（#48 AC-03）", () => {
    expect(resolveReturnTo("/users/abcDEF_123-x")).toBe("/users/abcDEF_123-x");
    expect(loginPathFor("/users/abcDEF_123-x")).toBe("/login?returnTo=%2Fusers%2FabcDEF_123-x");
    expect(resolveReturnTo("/users/abc/edit")).toBe("/");
    expect(resolveReturnTo("/questions?resolution=open")).toBe("/questions?resolution=open");
    expect(resolveReturnTo(`/questions/${questionId}`)).toBe(`/questions/${questionId}`);
    expect(resolveReturnTo("/alumni?q=%E5%8D%92%E6%A5%AD&graduationYear=2026"))
      .toBe("/alumni?q=%E5%8D%92%E6%A5%AD&graduationYear=2026");
  });

  it("実装済みの管理画面（AD-11・AD-15）は戻り先にし、未実装の管理画面は戻り先にしない", () => {
    expect(resolveReturnTo("/admin/users/abcDEF_123-x")).toBe("/admin/users/abcDEF_123-x");
    expect(resolveReturnTo("/admin/profile-reviews?status=all&review=" + questionId))
      .toBe("/admin/profile-reviews?status=all&review=" + questionId);
    expect(resolveReturnTo("/admin/graduation?mode=history")).toBe("/admin/graduation?mode=history");
    for (const path of ["/admin", "/admin/users", "/admin/users/a/b", "/admin/profile-reviews/" + questionId]) {
      expect(resolveReturnTo(path), path).toBe("/");
    }
  });

  it("未定義のパラメーター名を含むルートは設定の誤りとして扱う", () => {
    expect(() => matchesScreenRoute("/x/1", ["/x/[unknownId]"])).toThrow("未定義のルートパラメーター");
  });

  it.each([
    "/questions/[questionID]",
    "/questions/[question_id]",
    "/questions/[question-id]",
    "/questions/[]",
    "/questions/[questionId",
    "/questions/questionId]",
    "/questions/x[questionId]",
    "/questions/[[questionId]]",
    "/questions/[toString]",
  ])("角括弧を含むセグメントは定義済みのパラメーター名だけを受け付ける: %s", (route) => {
    expect(() => matchesScreenRoute("/questions/0b6f2c1e-5d4a-4c3b-9a8f-7e6d5c4b3a21", [route]))
      .toThrow("未定義のルートパラメーター");
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

  it.each([undefined, "/", "//example.com", "/notices"])("既定・許可外の戻り先 %s は付けない", (value) => {
    expect(loginPathFor(value)).toBe("/login");
  });
});
