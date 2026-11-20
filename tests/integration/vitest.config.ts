import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

import DurationSequencer from "./shard-sequencer.ts";

// Files that start servers in process and need no database: they run in the unit job.
const NO_DATABASE = [
  "src/http/**/*.test.ts",
  "src/supabase-pipeline.test.ts",
  "src/supabase-claim-fixtures.test.ts",
];

const library = path.resolve(import.meta.dirname, "../../packages/permdock");

// `scripts/select-tests.ts` lists changed tests through the module graph. The tests import the
// built `dist/`, which the graph cannot trace to a source edit, so the list step maps each
// export to its source file. Runs always use `dist/` (docs/decisions/0021).
function sourceAliases(): { find: string; replacement: string }[] {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(library, "package.json"), "utf8"),
  );
  const exportsField =
    typeof manifest === "object" && manifest !== null && "exports" in manifest
      ? manifest.exports
      : null;
  if (typeof exportsField !== "object" || exportsField === null) {
    return [];
  }
  const aliases: { find: string; replacement: string }[] = [];
  for (const [key, value] of Object.entries(exportsField)) {
    const target: unknown =
      typeof value === "object" && value !== null && "default" in value
        ? value.default
        : null;
    const match =
      typeof target === "string"
        ? /^\.\/dist\/(.+?)(\/index)?\.js$/u.exec(target)
        : null;
    if (match?.[1] === undefined) {
      continue;
    }
    const direct = path.join(library, "src", `${match[1]}.ts`);
    const index = path.join(library, "src", match[1], "index.ts");
    const source = existsSync(index) ? index : direct;
    if (existsSync(source)) {
      aliases.push({
        find: key === "." ? "permdock" : `permdock/${key.slice(2)}`,
        replacement: source,
      });
    }
  }
  return aliases.toSorted((a, b) => b.find.length - a.find.length);
}

export default defineConfig({
  resolve: {
    alias:
      // oxlint-disable-next-line turbo/no-undeclared-env-vars -- set by select-tests.ts for one list call
      process.env["PERMDOCK_SELECT_SRC"] === "1"
        ? sourceAliases().map(({ find, replacement }) => ({
            find: new RegExp(`^${find.replaceAll("/", "\\/")}$`, "u"),
            replacement,
          }))
        : [],
  },
  test: {
    sequence: { sequencer: DurationSequencer },
    testTimeout: 120_000,
    hookTimeout: 120_000,
    projects: [
      {
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.test.ts"],
          exclude: NO_DATABASE,
        },
      },
      { extends: true, test: { name: "servers", include: NO_DATABASE } },
      {
        extends: true,
        test: { name: "rls-bench", include: ["bench/**/*.test.ts"] },
      },
      {
        extends: true,
        test: { name: "plan-gate", include: ["gate/**/*.test.ts"] },
      },
    ],
  },
});
