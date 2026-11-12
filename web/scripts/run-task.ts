import nextEnv from "@next/env";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareTask, projectTasks } from "./lib/project-tasks";

const root = fileURLToPath(new URL("../", import.meta.url));
const [name = "", ...extraArguments] = process.argv.slice(2);

try {
  if (name === "--help" || extraArguments.includes("--help")) {
    console.info("開発コマンド（--help は設定やDBを変更しません）:");
    for (const [taskName, task] of Object.entries(projectTasks)) {
      console.info(`  npm run ${taskName} — 必要: ${task.requiredFiles.join(", ")}`);
    }
  } else {
    nextEnv.loadEnvConfig(root);
    const task = prepareTask(name, root, process.env, extraArguments);
    const manifestPath = resolve(root, "node_modules", task.packageName, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      bin: string | Record<string, string>;
    };
    const binary = typeof manifest.bin === "string"
      ? manifest.bin
      : manifest.bin[task.binaryName];
    if (!binary) {
      throw new Error(`${task.packageName} のCLIがありません。npm ci を実行してください。`);
    }

    const result = spawnSync(
      process.execPath,
      [resolve(dirname(manifestPath), binary), ...task.args, ...extraArguments],
      { cwd: root, env: process.env, stdio: "inherit", shell: false },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "開発コマンドに失敗しました。");
  process.exitCode = 1;
}
