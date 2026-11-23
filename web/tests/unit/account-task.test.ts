import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { expectExit, type TaskResult } from "../integration/account-task";

/** 結合テストの共通ヘルパー `expectExit` が、失敗時に原因を示すこと（#56）。 */

function failureMessage(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expectExit が失敗しませんでした");
}

/**
 * 時間切れで止められた `spawnSync` の結果。子プロセスの起動時間に左右されずに表示を確認するため、
 * 停止までに標準エラーを書いた状態を直接作る。
 */
function timedOutResult(stderr: string): TaskResult {
  const error = Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" });
  return { pid: 1, output: [null, "", stderr], stdout: "", stderr, status: null, signal: "SIGTERM", error };
}

describe("expectExit", () => {
  it("AC-01：標準エラーを出力した後に時間切れになると、時間切れの理由と標準エラーの両方を表示する", () => {
    const marker = "issue56-stderr-before-timeout";
    const message = failureMessage(() => expectExit(timedOutResult(`${marker}\n`), 0));
    expect(message).toContain("時間切れ");
    expect(message).toContain("spawnSync node ETIMEDOUT");
    expect(message).toContain(marker);
  });

  it("AC-01：実際に時間切れで止めた子プロセスでも、停止までの標準エラーを表示する", () => {
    // 子プロセスの起動が遅い環境でも標準エラーを書き終えてから止まるよう、時間切れには十分な余裕を取る。
    const marker = "issue56-real-timeout";
    const result = spawnSync(process.execPath, [
      "-e", `process.stderr.write(${JSON.stringify(marker)} + "\\n"); setTimeout(() => {}, 60_000);`,
    ], { encoding: "utf8", timeout: 5_000 });
    expect(result.error).toBeDefined();

    const message = failureMessage(() => expectExit(result, 0));
    expect(message).toContain(result.error!.message);
    expect(message).toContain(marker);
  }, 20_000);

  it("終了コードが違う場合も、終了コードと標準エラーを表示する", () => {
    const result = spawnSync(process.execPath, ["-e", "process.stderr.write('issue56-exit'); process.exit(3);"], {
      encoding: "utf8",
    });
    const message = failureMessage(() => expectExit(result, 0));
    expect(message).toContain("終了コード 3");
    expect(message).toContain("issue56-exit");
  });

  it("標準エラーが空なら、その旨を表示する", () => {
    const result = spawnSync(process.execPath, ["-e", "process.exit(2);"], { encoding: "utf8" });
    expect(failureMessage(() => expectExit(result, 0))).toContain("標準エラー: なし");
  });

  it("期待した終了コードなら失敗しない", () => {
    const result = spawnSync(process.execPath, ["-e", "process.exit(1);"], { encoding: "utf8" });
    expect(() => expectExit(result, 1)).not.toThrow();
  });
});
