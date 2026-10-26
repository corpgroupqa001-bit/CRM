import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: { "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }] },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".next-*/**",   // NEXT_DIST_DIR builds (e.g. .next-prod) next to a running dev server
      "out/**",
      "build/**",
      "next-env.d.ts",
      "supabase/functions/**",
    ],
  },
];

export default eslintConfig;
