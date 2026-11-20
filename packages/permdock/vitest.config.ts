import type { Plugin } from "vitest/config";

import { transformAsync } from "@babel/core";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import reactCompiler from "babel-plugin-react-compiler";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";

declare module "vitest" {
  interface ProvidedContext {
    readonly requireAuthzenVectors: boolean;
  }
}

const reactDir = path.dirname(
  createRequire(import.meta.url).resolve("react/package.json"),
);

// Apps that enable the React Compiler compile the hooks too (Expo compiles
// workspace packages): the hooks must behave the same once memoised by it.
function compileReact(): Plugin {
  return {
    name: "react-compiler",
    enforce: "pre",
    async transform(code, id) {
      if (
        !/\/src\/(?:(?:react|react-native|client)\/[^?]+|next\/client)\.tsx?$/u.test(
          id,
        )
      ) {
        return null;
      }
      const result = await transformAsync(code, {
        filename: id,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [[reactCompiler, { panicThreshold: "all_errors" }]],
        sourceMaps: true,
      });
      const compiled = result?.code;
      if (typeof compiled !== "string") {
        return null;
      }
      return { code: compiled, map: JSON.stringify(result?.map) };
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
          // The first CLI `run()` in a worker transforms and instruments `src/cli` from
          // source; with coverage on and two suites running in parallel it measured 4.6 s.
          testTimeout: 15_000,
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
          exclude: ["tests/**/*.browser.test.ts", "tests/**/*.flight.test.tsx"],
        },
      },
      {
        // Real Flight streams: `React.cache` memoises only under the
        // `react-server` condition, which Node applies from `execArgv`.
        extends: true,
        resolve: {
          conditions: ["react-server"],
          // Vite resolves React and its JSX runtimes without the condition.
          alias: [
            {
              find: /^react$/u,
              replacement: `${reactDir}/react.react-server.js`,
            },
            {
              find: /^react\/jsx-(dev-)?runtime$/u,
              replacement: `${reactDir}/jsx-$1runtime.react-server.js`,
            },
          ],
        },
        test: {
          name: "flight",
          execArgv: ["--conditions=react-server"],
          include: ["tests/**/*.flight.test.tsx"],
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
            "tests/next/*.browser.test.ts",
          ],
        },
      },
    ],
    coverage: {
      // Full runs on main, the nightly run and `ci:full` pull requests set COVERAGE; a selected
      // run covers a fraction of `src/` and cannot meet a floor.
      enabled: process.env["COVERAGE"] !== undefined,
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/index.ts",
        "src/cli/bin.ts",
        // Dynamic import of the optional `jose` peer.
        "src/jwt/load-jose.ts",
      ],
      // One floor, never raised by a script: a test owns a behaviour, not a line.
      thresholds: { statements: 90, lines: 90, functions: 90, branches: 90 },
    },
  },
});
