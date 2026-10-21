import { defineConfig } from "oxlint";

import {
  core,
  ignorePatterns,
  library,
  neverImport,
  test,
} from "@permdock/ox-config/oxlint";

/**
 * An adapter family's runtime imports go through its kit and nothing else
 * outside its own folder: not core internals, not another adapter. Type imports
 * stay free, because they are erased.
 */
function kitBoundary(
  family: string,
  allowed: readonly string[],
): ["error", Record<string, unknown>] {
  return [
    "error",
    {
      paths: neverImport.paths,
      patterns: [
        ...neverImport.patterns,
        {
          group: ["../**", ...allowed.map((path) => `!${path}`)],
          allowTypeImports: true,
          message: `${family} adapters import runtime code from ${allowed.join(" or ")} only (AGENTS.md, architecture.mdc).`,
        },
      ],
    },
  ];
}

export default defineConfig({
  extends: [core, library],
  ignorePatterns: [...ignorePatterns, "tmp/**"],
  overrides: [
    {
      files: ["src/**/*.{ts,tsx}"],
      rules: { "typescript/no-generated-empty-object-type": "error" },
    },
    {
      files: [
        "src/{hono,express,fastify,elysia,nest,node,h3,sveltekit,astro,solid-start,tanstack-start,trpc,orpc}/**/*.{ts,tsx}",
      ],
      rules: {
        "eslint/no-restricted-imports": kitBoundary("HTTP", [
          "../server/kit.ts",
          "../node/http.ts",
        ]),
      },
    },
    {
      files: ["src/{ai-sdk,claude-agent,openai,eve}/**/*.{ts,tsx}"],
      rules: {
        "eslint/no-restricted-imports": kitBoundary("Agent", [
          "../agent/kit.ts",
        ]),
      },
    },
    {
      files: ["src/{react,vue,svelte,solid}/**/*.{ts,tsx}"],
      rules: {
        "eslint/no-restricted-imports": kitBoundary("UI", ["../client/kit.ts"]),
      },
    },
    {
      files: [
        "src/cli/**/*.{ts,tsx}",
        "src/unplugin/**/*.ts",
        "tests/cli/**/*.{ts,tsx}",
      ],
      rules: {
        // Commands process files in order for stable output (24 findings).
        "eslint/no-await-in-loop": "off",
        // Patterns match SQL and TypeScript source text (31 findings).
        "eslint/require-unicode-regexp": "off",
        // pgsql-parser and oxc-parser ASTs arrive untyped (5 findings).
        "typescript/no-unsafe-assignment": "off",
        // Optional flags and AST fields are checked for presence (2 findings).
        "typescript/strict-boolean-expressions": "off",
        // CLI internals are not a published API (14 findings).
        "typescript/explicit-function-return-type": "off",
        // Node built-ins are imported by name (34 findings).
        "unicorn/import-style": "off",
        // `import.meta.url` survives tsdown bundling of the bin (12 findings).
        "unicorn/prefer-import-meta-properties": "off",
        // Generated SQL is built one push per statement (12 findings).
        "unicorn/prefer-single-call": "off",
        // Lexers index UTF-16 code units to match parser offsets (1 finding).
        "unicorn/prefer-code-point": "off",
        // The bin entry awaits at top level (1 finding).
        "node/no-top-level-await": "off",
        // Commands read PERMDOCK_COLLECT and injected env from the environment (3 findings).
        "node/no-process-env": "off",
      },
    },
    {
      files: ["src/terminal/**/*.{ts,tsx}"],
      rules: {
        // Token and storage lookups default to `process.env` (4 findings).
        "node/no-process-env": "off",
        // Token lookup tries refresh, CI OIDC and device flow in order (6 findings).
        "eslint/no-await-in-loop": "off",
      },
    },
    {
      files: ["src/nest/**/*.{ts,tsx}", "tests/nest/**/*.{ts,tsx}"],
      rules: {
        // Nest guards and controllers are classes by framework contract (6 findings).
        "eslint/class-methods-use-this": "off",
        // Nest modules are empty decorated classes (4 findings).
        "typescript/no-extraneous-class": "off",
        // A Nest module sits next to its controller and guard (3 findings).
        "eslint/max-classes-per-file": "off",
        // Nest needs the side-effect `reflect-metadata` import (2 findings).
        "import/no-unassigned-import": "off",
      },
    },
    {
      files: ["vitest.config.ts"],
      rules: {
        // The config hands CI to tests through `provide` (1 finding).
        "node/no-process-env": "off",
      },
    },
    {
      files: [
        "tests/**/*.{ts,tsx}",
        "**/*.{test,spec}.{ts,tsx}",
        "**/*.test-d.ts",
        "**/fixtures/**/*.ts",
        "src/testing/**/*.ts",
      ],
      plugins: test.plugins ?? [],
      rules: test.rules ?? {},
    },
  ],
});
