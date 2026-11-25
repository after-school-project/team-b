import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** E2Eの状態の設定（tests/e2e/database.ts）を、使い捨てDBとして起動したサーバーだけで実行すること。 */
const server = vi.hoisted(() => ({ clusterName: "", queries: [] as string[], connected: 0, ended: 0 }));

vi.mock("pg", () => ({
  Client: class {
    async connect() { server.connected += 1; }
    async end() { server.ended += 1; }
    async query(text: string) {
      if (text.includes("cluster_name")) return { rows: [{ name: server.clusterName }] };
      server.queries.push(text);
      return { rows: [{ id: "user-1" }] };
    }
  },
}));

beforeEach(() => {
  Object.assign(server, { clusterName: "", queries: [], connected: 0, ended: 0 });
  // 通常の開発DBをホストに公開した場合と同じ、使い捨てDBと区別できない接続先。
  vi.stubEnv("DATABASE_URL", "postgresql://team_b_app:dummy-secret@127.0.0.1:5432/team_b_dev");
});
afterEach(() => vi.unstubAllEnvs());

describe("E2E用DBの操作", () => {
  it.each(["", "main", "team-b", "team-b-e2e-2"])("cluster_name が %j のサーバーでは、読み書きをせずに失敗し、接続情報を出さない", async (name) => {
    const { resetProfileReviews, setUserState, userIdOf } = await import("../e2e/database");
    server.clusterName = name;
    for (const operate of [
      () => resetProfileReviews("poc_staff"), () => setUserState("poc_staff_mgr", { appManager: false }), () => userIdOf("poc_staff"),
    ]) {
      const error = await operate().then(() => null, (reason: Error) => reason);
      expect(error?.message).toContain("使い捨てDBではない");
      expect(error?.message).not.toContain("dummy-secret");
    }
    expect(server.queries).toEqual([]);
    expect(server.ended).toBe(server.connected);
  });

  it("使い捨てDBでは実行する", async () => {
    const { disposableClusterName, resetProfileReviews } = await import("../e2e/database");
    server.clusterName = disposableClusterName;
    await resetProfileReviews("poc_staff");
    expect(server.queries.filter((text) => text.startsWith("DELETE"))).toHaveLength(2);
  });

  const account = "team_b_app:dummy-secret@";
  it.each([
    "postgresql://" + account + "db.example.com:5432/team_b_dev",
    "postgresql://" + account + "localhost:5432/team_b_dev",
    "postgresql://" + account + "127.0.0.1:5432/other",
    // ポートの省略は、PGPORT の値が使われるため認めない。
    "postgresql://" + account + "127.0.0.1/team_b_dev",
    "postgresql://" + account + "127.0.0.1:6000/team_b_dev",
    // pg はクエリーの host・port・user・db で接続先を上書きする。
    "postgresql://" + account + "127.0.0.1:5432/team_b_dev?host=db.example.com",
    "postgresql://" + account + "127.0.0.1:5432/team_b_dev?port=6000",
    "postgresql://" + account + "127.0.0.1:5432/team_b_dev?user=team_b",
    "postgresql://" + account + "127.0.0.1:5432/team_b_dev?sslmode=disable",
    "postgresql://" + account + "127.0.0.1:5432/team_b_dev#fragment",
    "socket://" + account + "127.0.0.1:5432/team_b_dev?db=other",
    // 管理ロール・パスワードなし。
    "postgresql://team_b:dummy-secret@127.0.0.1:5432/team_b_dev",
    "postgresql://team_b_app@127.0.0.1:5432/team_b_dev",
    // URLとして解釈できない値。
    "postgresql://" + account + "[invalid/team_b_dev",
    "dummy-secret",
  ])("E2E用DBの接続先でなければ、接続せずに失敗し、接続情報を出さない：%s", async (url) => {
    const { resetProfileReviews, disposableClusterName } = await import("../e2e/database");
    server.clusterName = disposableClusterName;
    vi.stubEnv("DATABASE_URL", url);
    const error = await resetProfileReviews("poc_staff").then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("使い捨てDBではない");
    // 例外の付加情報（URL の解析エラーの input など）にも接続情報を含めない。
    expect(inspect(error, { showHidden: true, depth: 5 })).not.toContain("dummy-secret");
    expect(server.connected).toBe(0);
  });

  it("DATABASE_URL がなければ接続しない", async () => {
    const { userIdOf } = await import("../e2e/database");
    vi.stubEnv("DATABASE_URL", "");
    await expect(userIdOf("poc_staff")).rejects.toThrow("DATABASE_URL");
    expect(server.connected).toBe(0);
  });
});
