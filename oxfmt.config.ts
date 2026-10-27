import type { OxfmtConfig } from "oxfmt";

import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

const tailwindFunctions = ["cn", "cva", "tv"];

export default defineConfig({
  ...ultracite,
  trailingComma: "all",
  // Docs and READMEs keep their hand-wrapped lines; Ultracite's `never` would
  // rewrite every Markdown and MDX file.
  proseWrap: "preserve",
  // Descriptions open with identifiers and package names (`better-supabase`,
  // `stdout`, fixture ids) whose case is part of the meaning.
  jsdoc: {
    addDefaultToDescription: false,
    capitalizeDescriptions: false,
    preferCodeFences: true,
  },
  objectWrap: "collapse",
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "**/.agents/**",
    "**/.cursor/**",
    "**/.claude/**",
    "**/permissions.catalog.json",
    "packages/permdock/src/testing/fixtures/better-supabase.catalog.json",
    "packages/ui/src/**",
    "apps/marketing/components/blocks/**",
    "apps/marketing/components/examples/**",
    "tests/integration/src/support/prisma/**",
    "apps/examples/prisma/src/generated/**",
    "apps/examples/next-better-supabase/src/lib/supabase/{generated.*,blocks.generated.ts,database.types.ts}",
    "apps/examples/next-better-supabase/src/generated/**",
  ],
  sortImports: {
    internalPattern: ["@/", "@permdock/"],
    groups: [
      "type-import",
      ["value-builtin", "value-external"],
      "type-internal",
      "value-internal",
      ["type-parent", "type-sibling", "type-index"],
      ["value-parent", "value-sibling", "value-index"],
      "unknown",
    ],
  },
  sortPackageJson: { sortScripts: true },
  sortTailwindcss: { functions: tailwindFunctions },
  overrides: [
    {
      files: ["apps/docs/**"],
      options: {
        sortTailwindcss: {
          functions: tailwindFunctions,
          stylesheet: "apps/docs/app/global.css",
        },
      },
    },
    {
      files: ["apps/marketing/**"],
      options: {
        sortTailwindcss: {
          functions: tailwindFunctions,
          stylesheet: "apps/marketing/app/globals.css",
        },
      },
    },
    // Generators write JSON with `JSON.stringify(value, null, 2)`, and
    // `gen:check` compares their output byte for byte.
    {
      files: ["**/*.json", "**/*.jsonc", "**/*.json5"],
      options: { objectWrap: "preserve" },
    },
  ],
} satisfies OxfmtConfig);
