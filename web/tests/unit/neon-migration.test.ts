import { describe, expect, it } from "vitest";
import { neonMigrationMode, neonMigrationTarget } from "../../scripts/lib/neon-migration";

const environment = {
  DATABASE_URL_DIRECT: "postgresql://owner:synthetic-password@ep-demo.ap-northeast-1.aws.neon.tech/poc?sslmode=require&channel_binding=require",
  NEON_EXPECTED_HOST: "ep-demo.ap-northeast-1.aws.neon.tech",
  NEON_EXPECTED_DATABASE: "poc",
};

describe("Neon専用マイグレーションの接続条件", () => {
  it("接続予定と一致するTLS直接接続を受け付ける", () => {
    expect(neonMigrationTarget(environment)).toMatchObject({ host: environment.NEON_EXPECTED_HOST, database: "poc" });
  });
  it.each([
    "postgresql://owner:secret@db/team_b_dev?sslmode=require",
    environment.DATABASE_URL_DIRECT.replace("ep-demo.", "ep-demo-pooler."),
    environment.DATABASE_URL_DIRECT.replace("/poc?", "/other?"),
    environment.DATABASE_URL_DIRECT.replace("sslmode=require", "sslmode=disable"),
    environment.DATABASE_URL_DIRECT + "&sslmode=no-verify",
    environment.DATABASE_URL_DIRECT + "&ssl=false",
    "not-a-url-with-a-secret",
  ])("不適切な接続先・TLS設定を拒否し秘密値を出力しない", (connectionString) => {
    let message = "";
    try { neonMigrationTarget({ ...environment, DATABASE_URL_DIRECT: connectionString }); }
    catch (error) { message = (error as Error).message; }
    expect(message).not.toBe("");
    expect(message).not.toContain(connectionString);
    expect(message).not.toContain("synthetic-password");
  });
  it("接続予定の指定がなければ開始しない", () => {
    expect(() => neonMigrationTarget({ DATABASE_URL_DIRECT: environment.DATABASE_URL_DIRECT })).toThrow("NEON_EXPECTED_HOST");
  });
  it("接続確認と適用を明示的に区別し、追加引数を拒否する", () => {
    expect(neonMigrationMode(["--check"])).toBe("--check");
    expect(neonMigrationMode(["--apply"])).toBe("--apply");
    expect(() => neonMigrationMode([])).toThrow("Usage");
    expect(() => neonMigrationMode(["--apply", "--url=other"])).toThrow("Usage");
  });
});
