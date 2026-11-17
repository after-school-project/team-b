import { describe, expect, it } from "vitest";
import { productionPocConfig, shouldVerifyProduction } from "../../scripts/lib/poc-environment";

const environment = {
  DATABASE_URL: "postgresql://app:synthetic-password@ep-demo-pooler.us-east-1.aws.neon.tech/poc?sslmode=require",
  DATABASE_URL_UNPOOLED: "postgresql://owner:synthetic-password@ep-demo.us-east-1.aws.neon.tech/poc?sslmode=require",
  BETTER_AUTH_SECRET: "synthetic-poc-only-secret-at-least-32-characters",
  BETTER_AUTH_URL: "https://poc.example.invalid",
};

describe("PoC公開環境の設定", () => {
  it("Neon連携の変数名とアプリ・管理ロールの分離を受け付ける", () => {
    expect(productionPocConfig(environment).connectionString).toBe(environment.DATABASE_URL);
    expect(productionPocConfig({ ...environment, DATABASE_URL_UNPOOLED: undefined,
      DATABASE_URL_DIRECT: environment.DATABASE_URL_UNPOOLED }).connectionString).toBe(environment.DATABASE_URL);
  });
  it.each([
    { DATABASE_URL: undefined },
    { DATABASE_URL: "postgresql://app:secret@db/team_b_dev" },
    { DATABASE_URL: environment.DATABASE_URL.replace("sslmode=require", "sslmode=disable") },
    { DATABASE_URL: environment.DATABASE_URL + "&ssl=false" },
    { DATABASE_URL: environment.DATABASE_URL + "&sslmode=disable" },
    { DATABASE_URL_UNPOOLED: environment.DATABASE_URL },
    { DATABASE_URL_UNPOOLED: environment.DATABASE_URL_UNPOOLED.replace("/poc?", "/other?") },
    { BETTER_AUTH_SECRET: undefined },
    { BETTER_AUTH_SECRET: "team-b-compose-local-development-only" },
    { BETTER_AUTH_SECRET: "short" },
    { BETTER_AUTH_URL: undefined },
    { BETTER_AUTH_URL: "http://localhost:3000" },
    { BETTER_AUTH_URL: "https://localhost" },
    { BETTER_AUTH_URL: "https://user:secret@poc.example.invalid" },
    { BETTER_AUTH_URL: "https://poc.example.invalid/login" },
  ])("誤った設定を接続前に拒否し、秘密値をエラーに含めない: %j", (overrides) => {
    let message = "";
    try { productionPocConfig({ ...environment, ...overrides }); }
    catch (error) { message = (error as Error).message; }
    expect(message).not.toBe("");
    expect(message).not.toContain("synthetic-password");
    expect(message).not.toContain(environment.BETTER_AUTH_SECRET);
    expect(message).not.toContain("postgresql://");
  });
  it("Productionだけを検証し、Preview・ローカルへPoCの秘密値を要求しない", () => {
    expect(shouldVerifyProduction({ VERCEL: "1", VERCEL_ENV: "production" })).toBe(true);
    expect(shouldVerifyProduction({ VERCEL: "1", VERCEL_ENV: "preview" })).toBe(false);
    expect(shouldVerifyProduction({})).toBe(false);
    expect(() => shouldVerifyProduction({ VERCEL: "1" })).toThrow();
  });
});
