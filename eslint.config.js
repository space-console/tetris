// Flat ESLint config for the zero-build launcher.
// Plain browser ES modules — no framework, no transpile.
import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["assets/js/**/*.js", "scripts/**/*.mjs"],
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
