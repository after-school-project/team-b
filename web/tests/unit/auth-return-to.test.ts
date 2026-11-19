import { describe, expect, it } from "vitest";
import { loginPathFor, resolveReturnTo } from "../../src/auth/return-to";

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

describe("戻り先付きのログイン画面URL", () => {
  it("許可した戻り先だけをクエリーに付ける", () => {
    expect(loginPathFor("/?tab=home")).toBe("/login?returnTo=%2F%3Ftab%3Dhome");
  });

  it.each([undefined, "/", "//example.com", "/questions"])("既定・許可外の戻り先 %s は付けない", (value) => {
    expect(loginPathFor(value)).toBe("/login");
  });
});
