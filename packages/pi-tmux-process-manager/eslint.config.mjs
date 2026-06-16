import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

const tsRules = {
  // ── 真正造过 bug 的规则，全部 error ──────────────────────────────────────
  // 重复声明（windowName already declared）
  "no-redeclare": "error",
  "@typescript-eslint/no-redeclare": "error",

  // use-before-define（TDZ：piCmd 用了还没声明的 promptTmpPath）
  "no-use-before-define": "off",
  "@typescript-eslint/no-use-before-define": ["error", { functions: false, classes: false }],

  // ESM 里用 require()
  "@typescript-eslint/no-require-imports": "error",

  // ── 代码质量 ──────────────────────────────────────────────────────────────
  "prefer-const": "error",
  "no-var": "error",
  "@typescript-eslint/no-unused-vars": ["warn", {
    argsIgnorePattern: "^_",
    varsIgnorePattern: "^_",
    caughtErrorsIgnorePattern: "^_",
  }],
};

export default [
  {
    // 源码：所有规则 error 级别
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsRules,
      // 源码 unused vars 升级到 error
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },
  {
    // 测试：unused vars 降为 warn（测试里常见）
    files: ["test/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsRules,
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },
];
