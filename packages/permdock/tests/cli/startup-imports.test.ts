import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src");
const STATIC_IMPORT =
  /^(?:import|export)\s+(?!type\s)(?:[\s\S]*?\sfrom\s+)?"([^"]+)";/gmu;
/**
 * The did-you-mean distance runs on every unknown command, so it loads up
 * front.
 */
const STARTUP_PACKAGES: ReadonlySet<string> = new Set(["fastest-levenshtein"]);

function staticImports(file: string): readonly string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(STATIC_IMPORT)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** Every module `entry` loads before its first dynamic `import()`. */
function staticGraph(entry: string): {
  readonly files: readonly string[];
  readonly packages: readonly string[];
} {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [join(SRC, entry)];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    for (const specifier of staticImports(file)) {
      if (specifier.startsWith(".")) {
        pending.push(join(dirname(file), specifier));
      } else if (!specifier.startsWith("node:")) {
        packages.add(specifier);
      }
    }
  }
  return {
    files: [...files].map((file) => relative(SRC, file)).toSorted(),
    packages: [...packages].toSorted(),
  };
}

describe("CLI startup", () => {
  it("loads only Node built-ins before the first dynamic import in the bin", () => {
    expect(staticGraph("cli/bin.ts")).toEqual({
      files: ["cli/bin.ts"],
      packages: [],
    });
  });

  it("parses, resolves and prints help without a command module", () => {
    for (const entry of ["cli/core/run.ts", "cli/core/help.ts"]) {
      const graph = staticGraph(entry);
      expect(
        graph.packages.filter((name) => !STARTUP_PACKAGES.has(name)),
      ).toEqual([]);
      expect(
        graph.files.filter((file) => file.startsWith("cli/commands/")),
      ).toEqual([]);
    }
  });

  it("answers --version without the CLI core", () => {
    expect(staticGraph("cli/core/version.ts")).toEqual({
      files: [
        "cli/core/version.ts",
        "cli/files.ts",
        "cli/project/package-root.ts",
      ],
      packages: [],
    });
  });
});
