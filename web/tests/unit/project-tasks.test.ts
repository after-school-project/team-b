import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareTask } from "../../scripts/lib/project-tasks";

const root = resolve(".");

describe("開発コマンドの実行条件", () => {
  it("未定義のコマンドを実行しない", () => {
    expect(() => prepareTask("__proto__", root, {})).toThrow("未定義");
  });

  it("認証設定が未実装なら生成を開始しない", () => {
    expect(() => prepareTask("auth:generate", root, {}, [], () => false))
      .toThrow("scripts/auth-schema.config.ts");
  });

  it("設定ファイルと環境変数が揃うまでマイグレーションを開始しない", () => {
    expect(() => prepareTask("db:migrate", root, {}, [], () => false))
      .toThrow("DIRECT_DATABASE_URL");
  });

  it("接続先を追加引数で上書きできない", () => {
    expect(() => prepareTask("db:migrate", root, {}, ["--url=unexpected-target"], () => true))
      .toThrow("追加引数は受け付けません");
  });

  it("必要条件を満たしたマイグレーションは固定した設定ファイルを使う", () => {
    const task = prepareTask("db:migrate", root, { DIRECT_DATABASE_URL: "set" }, [], () => true);
    expect(task.packageName).toBe("drizzle-kit");
    expect(task.args).toEqual(["migrate", "--config=drizzle.config.ts"]);
  });

  it("発行処理のエラーに秘密値を含めない", () => {
    const secret = "test-only-secret-that-must-not-be-logged";
    let message = "";
    try {
      prepareTask("account:issue", root, { BETTER_AUTH_SECRET: secret }, [], () => false);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("まだ実行できません");
    expect(message).not.toContain(secret);
  });
});
