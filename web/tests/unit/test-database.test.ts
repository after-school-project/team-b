import { describe, expect, it } from "vitest";
import { requireTestDatabaseUrl } from "../../scripts/lib/test-database";

describe("DB結合テストの接続先", () => {
  it("専用の接続URLがなければ実行しない", () => {
    expect(() => requireTestDatabaseUrl({ NODE_ENV: "test" })).toThrow("TEST_DATABASE_URL");
  });

  it("通常の実行環境では実行しない", () => {
    expect(() => requireTestDatabaseUrl({
      NODE_ENV: "production", TEST_DATABASE_URL: "postgresql://localhost/poc_test",
    })).toThrow("NODE_ENV=test");
  });

  it("PostgreSQL以外のURLを拒否する", () => {
    expect(() => requireTestDatabaseUrl({
      NODE_ENV: "test", TEST_DATABASE_URL: "https://example.invalid/poc_test",
    })).toThrow("有効なPostgreSQL");
  });

  it("ユーザー名やポート表記が違っても通常DBと同じ接続先を拒否する", () => {
    expect(() => requireTestDatabaseUrl({
      NODE_ENV: "test",
      TEST_DATABASE_URL: "postgresql://tester@localhost:5432/poc_dev",
      DATABASE_URL: "postgresql://app@localhost/poc_dev",
    })).toThrow("異なるテスト専用DB");
  });

  it("Neonのプール接続と直接接続を同じDBとして判定する", () => {
    expect(() => requireTestDatabaseUrl({
      NODE_ENV: "test",
      TEST_DATABASE_URL: "postgresql://tester@ep-demo.example.invalid/poc",
      DATABASE_URL_DIRECT: "postgresql://owner@ep-demo-pooler.example.invalid/poc",
    })).toThrow("異なるテスト専用DB");
  });

  it("独立したテストDBを利用できる", () => {
    const url = "postgresql://tester@localhost/poc_test";
    expect(requireTestDatabaseUrl({
      NODE_ENV: "test", TEST_DATABASE_URL: url, DATABASE_URL: "postgresql://app@localhost/poc_dev",
    })).toBe(url);
  });

  it("不正な接続URLをエラーへ出力しない", () => {
    const secret = "not-a-url-with-a-secret-password";
    let message = "";
    try {
      requireTestDatabaseUrl({ NODE_ENV: "test", TEST_DATABASE_URL: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("有効なPostgreSQL");
    expect(message).not.toContain(secret);
  });
});
