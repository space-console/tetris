// Flat ESLint config for the zero-build games collection.
// Plain browser ES modules — no framework, no transpile. Lints the shared
// modules, the hub, and every game folder.
import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Node context for the CI stamp script.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Build outputs / vendored assets — never lint these.
    ignores: ["_dist/**", "_site/**", "node_modules/**"],
  },
];
