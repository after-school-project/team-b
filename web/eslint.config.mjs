import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // 画面のDBエラーはSQL・引数を含んだままログに出るため、画面からは readForScreen だけを使う。
    files: ["src/app/**/*.{ts,tsx}"],
    ignores: ["src/app/api/**"],
    rules: {
      "no-restricted-syntax": ["error", {
        // エイリアス・相対パスのどちらの読み込みも対象にする（/ は /。セレクターの正規表現には / を書けない）。
        selector: ":matches(ImportExpression, ImportDeclaration[importKind!='type'], "
          + "ExportNamedDeclaration[exportKind!='type'], ExportAllDeclaration[exportKind!='type'])"
          + "[source.value=/(^|\\u002F)db\\u002Fclient(\\.[jt]s)?$/]",
        message: "画面からDBを読むときは @/db/screen-read の readForScreen を使ってください。",
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
