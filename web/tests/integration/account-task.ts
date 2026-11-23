import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const tsxCli = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));

/** 別プロセスの起動と型検査なしの TS 実行に時間がかかるため、混雑した環境でも打ち切らない長さにする。 */
const taskTimeoutMs = 60_000;

export type TaskResult = SpawnSyncReturns<string>;

/**
 * 開発担当のコマンド（`npm run account:*`）を、npm と同じ入口（`scripts/run-task.ts`）で別プロセスとして実行する。
 * npm を介さず Node.js から直接起動するため、Windows でもシェルなしで動き、起動時間も短い。
 */
export function runAccountTask(task: string, args: readonly string[], env: Record<string, string>): TaskResult {
  return spawnSync(process.execPath, [tsxCli, "scripts/run-task.ts", task, ...args], {
    cwd: webRoot,
    encoding: "utf8",
    timeout: taskTimeoutMs,
    env: { ...process.env, ...env },
  });
}

/**
 * 終了コードを確認する。失敗時は、起動できなかった・時間切れ・別の終了コードのどれかを、標準エラーと一緒に示す。
 * コマンドは秘密値を出力しない（出力に含まれないことは各テストで確認する）ため、標準エラーをそのまま示してよい。
 */
export function expectExit(result: TaskResult, code: number): void {
  expect(result.error, `コマンドを起動できないか時間切れになりました: ${result.error?.message ?? ""}`).toBeUndefined();
  expect(result.status, `終了コード ${result.status ?? "なし"}（signal: ${result.signal ?? "なし"}）\n${result.stderr}`).toBe(code);
}
