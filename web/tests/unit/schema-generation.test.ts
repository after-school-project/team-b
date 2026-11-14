import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

it("実際のDrizzle設定を読み込み、DB接続なしでSQLを生成できる", () => {
  const scratch = mkdtempSync(join(root, ".toolchain-probe-"));
  try {
    const schemaPath = join(scratch, "schema.ts");
    const configPath = join(scratch, "drizzle.config.ts");
    const outputPath = join(scratch, "migrations");
    writeFileSync(schemaPath, [
      'import { pgTable, integer } from "drizzle-orm/pg-core";',
      'export const probe = pgTable("toolchain_probe", { id: integer("id").primaryKey() });',
    ].join("\n"));
    writeFileSync(configPath, [
      `import projectConfig from ${JSON.stringify(resolve(root, "drizzle.config.ts").replaceAll("\\", "/"))};`,
      `export default { ...projectConfig, ...${JSON.stringify({
        schema: schemaPath.replaceAll("\\", "/"),
        out: outputPath.replaceAll("\\", "/"),
      })} };`,
    ].join("\n"));

    const result = spawnSync(process.execPath, [
      resolve(root, "node_modules/drizzle-kit/bin.cjs"), "generate", `--config=${configPath}`,
    ], { cwd: root, encoding: "utf8", timeout: 20_000, env: { ...process.env, NODE_ENV: "test", DATABASE_URL_DIRECT: "" } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const migrations = readdirSync(outputPath).filter((name) => name.endsWith(".sql"));
    expect(migrations).toHaveLength(1);
    expect(readFileSync(join(outputPath, migrations[0]), "utf8"))
      .toContain('CREATE TABLE "toolchain_probe"');
  } finally {
    const resolved = resolve(scratch);
    if (dirname(resolved) !== resolve(root) || !basename(resolved).startsWith(".toolchain-probe-")) {
      throw new Error("一時検証フォルダーが作業ディレクトリ外を指しています。");
    }
    rmSync(resolved, { recursive: true, force: true });
  }
}, 30_000);
