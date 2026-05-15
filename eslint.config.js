import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import json from "@eslint/json";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".turbo/**",
      "**/.next/**",
      "**/.well-known/**",
      "**/.swc/**",
      "**/vendored/**",
    ],
  },

  {
    files: ["**/*.{js,mjs,cjs}"],
    ...js.configs.recommended,
    languageOptions: {
      globals: globals.node,
    },
  },

  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx,mts,cts}"],
  })),

  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  {
    files: ["**/*.config.{js,ts,mjs,mts}"],
    ...tseslint.configs.disableTypeChecked,
  },

  // Workflow step / workflow functions use `async` as the framework's marker
  // for "this is a step or workflow", so async-without-await is idiomatic.
  {
    files: ["packages/examples/workflow/src/workflows/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },

  {
    files: ["**/*.json"],
    ignores: ["package-lock.json"],
    language: "json/json",
    ...json.configs.recommended,
  },

  {
    files: ["**/tsconfig*.json", ".vscode/*.json"],
    language: "json/jsonc",
    ...json.configs.recommended,
  },
];
