import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { expectExit } from "../integration/account-task";

/** 結合テストの共通ヘルパー `expectExit` が、失敗時に原因を示すこと（#56）。 */

function failureMessage(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expectExit が失敗しませんでした");
}

/** 標準エラーに書いてから待ち続ける子プロセスを、短い時間切れで止める。 */
function timedOutChild(marker: string) {
  return spawnSync(process.execPath, [
    "-e", `process.stderr.write(${JSON.stringify(marker)} + "\\n"); setTimeout(() => {}, 60_000);`,
  ], { encoding: "utf8", timeout: 2_000 });
}

describe("expectExit", () => {
  it("AC-01：標準エラーを出力した後に時間切れになると、時間切れの理由と標準エラーの両方を表示する", () => {
    const marker = "issue56-stderr-before-timeout";
    const result = timedOutChild(marker);
    expect(result.error).toBeDefined();
    expect(result.stderr).toContain(marker);

    const message = failureMessage(() => expectExit(result, 0));
    expect(message).toContain("時間切れ");
    expect(message).toContain(result.error!.message);
    expect(message).toContain(marker);
  }, 15_000);

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
