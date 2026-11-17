import { describe, expect, it, vi } from "vitest";
import { databaseConfig } from "../../src/db/config";
import { localDatabaseTarget, localSetupMode } from "../../scripts/lib/local-database";
import { managementDatabaseConfig } from "../../scripts/lib/management-config";

vi.mock("server-only", () => ({}));

const local = "postgresql://team_b:synthetic-password@db:5432/team_b_dev";
const neon = "postgresql://app:synthetic-password@ep-demo-pooler.aws.neon.tech/poc?sslmode=require&channel_binding=require";
const resetEnvironment = { DATABASE_URL_DIRECT: local, NODE_ENV: "development", LOCAL_DATABASE_RESET: "team-b-compose-local" };

describe("DB接続設定", () => {
  it("ローカルはTLSなし、Neonは証明書検証付きTLSに固定する", () => {
    expect(databaseConfig({ DATABASE_URL: local }).ssl).toBe(false);
    const config = databaseConfig({ DATABASE_URL: neon, NODE_ENV: "production" });
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.enableChannelBinding).toBe(true);
    expect(config.connectionString).not.toContain("?");
  });

  it.each([undefined, "", "invalid-secret", local + "?ssl=false", neon + "&sslmode=disable",
    neon.replace("sslmode=require", "sslmode=disable"), neon.replace(".neon.tech", ".example.invalid"),
    neon + "&sslrootcert=secret", neon + "&channel_binding=require"])("危険・不正な設定を秘密値なしで拒否する", (value) => {
    expect(() => databaseConfig({ DATABASE_URL: value })).toThrow(/^DATABASE_URL に有効なDB接続情報/);
  });

  it("アプリ用接続から管理用設定へフォールバックしない", () => {
    expect(() => databaseConfig({ DATABASE_URL_DIRECT: local })).toThrow("DATABASE_URL に");
    expect(() => databaseConfig({ DATABASE_URL: local }, "DATABASE_URL_DIRECT")).toThrow("DATABASE_URL_DIRECT に");
    expect(() => databaseConfig({ DATABASE_URL: local, VERCEL: "1" })).toThrow();
    expect(() => databaseConfig({ DATABASE_URL_DIRECT: neon }, "DATABASE_URL_DIRECT")).toThrow();
  });

  it("Neonの管理操作には接続予定ホストとDB名の一致も要求する", () => {
    const direct = neon.replace("-pooler", "");
    expect(() => managementDatabaseConfig({ DATABASE_URL_DIRECT: direct })).toThrow("NEON_EXPECTED_HOST");
    expect(managementDatabaseConfig({ DATABASE_URL_DIRECT: direct, NEON_EXPECTED_HOST: "ep-demo.aws.neon.tech", NEON_EXPECTED_DATABASE: "poc" }).ssl)
      .toEqual({ rejectUnauthorized: true });
  });

  it("開発時にモジュールを再読み込みしても同じプールを共有する", async () => {
    vi.stubEnv("DATABASE_URL", local);
    const first = (await import("../../src/db/pool")).applicationPool();
    try {
      for (let i = 0; i < 10; i++) {
        vi.resetModules();
        expect((await import("../../src/db/pool")).applicationPool()).toBe(first);
      }
      expect(first.totalCount).toBe(0);
    } finally {
      await first.end();
      delete (globalThis as { teamBDatabasePool?: unknown }).teamBDatabasePool;
      vi.unstubAllEnvs();
    }
  });
});

describe("ローカル初期化・リセットの安全確認", () => {
  it("明示コマンドと開発Composeの設定を要求する", () => {
    expect(localSetupMode(["--reset-local"])).toBe("reset");
    expect(() => localSetupMode(["--reset-local", "--force"])).toThrow();
    expect(localDatabaseTarget(resetEnvironment, true).pathname).toBe("/team_b_dev");
  });
  it.each([
    { NODE_ENV: "production" }, { NODE_ENV: "test" }, { NODE_ENV: undefined }, { VERCEL: "1" },
    { LOCAL_DATABASE_RESET: undefined }, { DATABASE_URL_DIRECT: undefined },
    { DATABASE_URL_DIRECT: "postgresql://team_b:synthetic-password@ep-demo.aws.neon.tech/team_b_dev?sslmode=require" },
    { DATABASE_URL_DIRECT: local.replace("@db", "@remote.example.invalid") },
    { DATABASE_URL_DIRECT: local.replace("/team_b_dev", "/team_b_poc") },
    { DATABASE_URL_DIRECT: local.replace("team_b:", "team_b_app:") },
    { DATABASE_URL_DIRECT: local + "?host=remote.example.invalid" },
    { DATABASE_URL_DIRECT: local.replace(":5432", ":6543") },
  ])("PoC・本番相当・曖昧な接続先ではリセットを拒否する: %j", (overrides) => {
    expect(() => localDatabaseTarget({ ...resetEnvironment, ...overrides }, true)).toThrow(/^開発DBの初期化はローカル/);
  });
});
