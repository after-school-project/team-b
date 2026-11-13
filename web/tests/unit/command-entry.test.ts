import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

it("tsxからコマンド入口を起動し、設定やDBを変更せずヘルプを表示できる", () => {
  const result = spawnSync(process.execPath, [
    resolve(root, "node_modules/tsx/dist/cli.mjs"), "scripts/run-task.ts", "--help",
  ], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test" },
    encoding: "utf8",
    timeout: 10_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("npm run auth:generate");
  expect(result.stdout).toContain("npm run db:migrate");
});
