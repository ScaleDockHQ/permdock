import { transformAsync } from "@babel/core";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import reactCompiler from "babel-plugin-react-compiler";
import { existsSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";

declare module "vitest" {
  interface ProvidedContext {
    readonly requireAuthzenVectors: boolean;
  }
}

// Thresholds follow CI's test set, which includes the official AuthZEN vectors
// (`pnpm authzen:vectors`); CI itself never rewrites this file.
const raiseThresholds =
  process.env["CI"] === undefined &&
  existsSync(
    new URL(
      "tests/testing/fixtures/authzen/decisions-authorization-api-1_0-02.json",
      import.meta.url,
    ),
  );

// Apps that enable the React Compiler compile the hooks too (Expo compiles
// workspace packages): the hooks must behave the same once memoised by it.
function compileReact(): Plugin {
  return {
    name: "react-compiler",
    enforce: "pre",
    async transform(code, id) {
      if (!/\/src\/(?:react|react-native|client)\/[^?]+\.tsx?$/u.test(id)) {
        return null;
      }
      const result = await transformAsync(code, {
        filename: id,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [[reactCompiler, { panicThreshold: "all_errors" }]],
        sourceMaps: "inline",
      });
      return result?.code ?? null;
    },
  };
}

export default defineConfig({
  test: {
    // CI fetches the official AuthZEN vectors first; a missing file there fails.
    provide: { requireAuthzenVectors: process.env["CI"] !== undefined },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
          exclude: ["tests/**/*.browser.test.ts"],
        },
      },
      {
        // Svelte and Solid client builds: rune and signal reactivity only
        // exists under the `browser` condition.
        extends: true,
        plugins: [svelte()],
        resolve: { conditions: ["browser"] },
        test: {
          name: "browser",
          environment: "happy-dom",
          // One `solid-js` instance: `solid-js/web` must not reach the Node
          // (server) build through an external import.
          server: { deps: { inline: [/solid-js/u] } },
          include: ["tests/**/*.browser.test.ts"],
        },
      },
      {
        extends: true,
        plugins: [compileReact()],
        resolve: { conditions: ["browser"] },
        test: {
          name: "react-compiler",
          environment: "happy-dom",
          include: [
            "tests/react/*.browser.test.ts",
            "tests/react-native/*.browser.test.ts",
          ],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/index.ts",
        "src/cli/bin.ts",
        // Dynamic import of the optional `jose` peer.
        "src/jwt/load-jose.ts",
      ],
      thresholds: {
        autoUpdate: raiseThresholds
          ? (threshold): number => Math.floor(threshold)
          : false,
        statements: 98,
        lines: 98,
        functions: 99,
        branches: 95,
        "src/core/**": {
          statements: 97,
          lines: 97,
          functions: 99,
          branches: 95,
        },
        "src/conditions/**": {
          statements: 96,
          lines: 96,
          functions: 100,
          branches: 95,
        },
        "src/cli/**": {
          statements: 98,
          lines: 98,
          functions: 99,
          branches: 96,
        },
        "src/testing/**": {
          statements: 97,
          lines: 97,
          functions: 98,
          branches: 90,
        },
      },
    },
  },
});
