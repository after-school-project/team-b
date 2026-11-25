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
        // エイリアス・相対パスのどちらの読み込みも対象にする。セレクターの正規表現にはスラッシュを書けないため、文字コードで表す。
        // 型だけの読み込みは、文全体・名前ごと（import { type db }）のどちらの書き方でも許可する。
        selector: ":matches(ImportExpression, ExportAllDeclaration[exportKind!='type'], "
          + "ImportDeclaration[importKind!='type']:matches([specifiers.length=0], "
          + ":has(ImportDefaultSpecifier, ImportNamespaceSpecifier, ImportSpecifier[importKind!='type'])), "
          + "ExportNamedDeclaration[exportKind!='type']:has(ExportSpecifier[exportKind!='type']))"
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
