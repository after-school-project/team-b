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
        selector: ":matches(ImportExpression, ImportDeclaration[importKind!='type'])[source.value='@/db/client']",
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
