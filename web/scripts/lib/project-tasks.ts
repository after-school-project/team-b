import { statSync } from "node:fs";
import { resolve } from "node:path";

type ProjectTask = {
  packageName: string;
  binaryName: string;
  args: string[];
  requiredFiles: string[];
  requiredEnv?: string[];
  acceptsArguments?: boolean;
};

export const projectTasks = {
  "auth:generate": {
    packageName: "auth",
    binaryName: "auth",
    args: [
      "generate",
      "--config", "scripts/auth-schema.ts",
      "--adapter", "drizzle",
      "--dialect", "postgresql",
      "--output", "src/db/auth-schema.ts",
      "--yes",
    ],
    requiredFiles: ["scripts/auth-schema.ts"],
  },
  "db:generate": {
    packageName: "drizzle-kit",
    binaryName: "drizzle-kit",
    args: ["generate", "--config=drizzle.config.ts"],
    requiredFiles: ["drizzle.config.ts", "src/db/schema.ts"],
  },
  "db:migrate": {
    packageName: "drizzle-kit",
    binaryName: "drizzle-kit",
    args: ["migrate", "--config=drizzle.config.ts"],
    requiredFiles: [
      "drizzle.config.ts",
      "drizzle/meta/_journal.json",
    ],
    requiredEnv: ["DATABASE_URL_DIRECT"],
  },
  "db:seed": {
    packageName: "tsx",
    binaryName: "tsx",
    args: ["scripts/setup-db.ts", "--seed-only"],
    requiredFiles: ["scripts/setup-db.ts"],
    requiredEnv: ["DATABASE_URL_DIRECT"],
  },
  "account:issue": {
    packageName: "tsx",
    binaryName: "tsx",
    args: ["scripts/tasks/issue-account.ts"],
    requiredFiles: ["scripts/tasks/issue-account.ts"],
    requiredEnv: ["DATABASE_URL_DIRECT", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"],
    acceptsArguments: true,
  },
  "account:reset-password": {
    packageName: "tsx",
    binaryName: "tsx",
    args: ["scripts/tasks/reset-password.ts"],
    requiredFiles: ["scripts/tasks/reset-password.ts"],
    requiredEnv: ["DATABASE_URL_DIRECT", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"],
    acceptsArguments: true,
  },
} satisfies Record<string, ProjectTask>;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function prepareTask(
  name: string,
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
  extraArguments: string[] = [],
  hasFile: (path: string) => boolean = isFile,
): ProjectTask {
  if (!Object.hasOwn(projectTasks, name)) {
    throw new Error("未定義の開発コマンドです。");
  }

  const task: ProjectTask = projectTasks[name as keyof typeof projectTasks];
  if (extraArguments.length > 0 && !task.acceptsArguments) {
    throw new Error(`${name}: 追加引数は受け付けません。設定ファイルで指定してください。`);
  }

  const missingFiles = task.requiredFiles.filter((path) => !hasFile(resolve(root, path)));
  const missingEnv = (task.requiredEnv ?? []).filter((key) => !environment[key]?.trim());
  if (missingFiles.length > 0 || missingEnv.length > 0) {
    const details = [
      missingFiles.length > 0 ? `必要な設定・実装: ${missingFiles.join(", ")}` : "",
      missingEnv.length > 0 ? `必要な環境変数: ${missingEnv.join(", ")}` : "",
    ].filter(Boolean);
    throw new Error(`${name} はまだ実行できません。${details.join("。")}`);
  }

  return task;
}
