import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // benchmark/ is standalone Python; its .venv vendors JS that is not ours to lint.
    ignores: ["**/dist/**", "**/node_modules/**", "apps/ingest/**", "**/.venv/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
