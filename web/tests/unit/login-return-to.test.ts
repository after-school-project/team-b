import { describe, expect, it } from "vitest";
import { resolveReturnTo } from "../../src/app/login/return-to";

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
    "javascript:alert(1)",
    ["//example.com"],
  ])("許可外の戻り先 %s をホームにする", (value) => {
    expect(resolveReturnTo(value)).toBe("/");
  });
});
