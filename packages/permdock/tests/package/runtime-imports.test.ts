import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

/**
 * Invariant 12 on the source graph. The CLI packages are inlined into the CLI
 * chunks, so `dist` no longer names them and `tests/bundle` cannot see a leak;
 * this walks every runtime entry's runtime imports from `src` instead.
 */
const ROOT = path.resolve(import.meta.dirname, "../..");
const CLI_ONLY_PACKAGES = [
  "@clack/prompts",
  "diff",
  "fastest-levenshtein",
  "jiti",
  "oxc-parser",
  "package-manager-detector",
  "smol-toml",
] as const;
const TOOLING_SOURCES = [
  "src/cli/",
  "src/testing/",
  "src/unplugin/",
  "src/next/plugin.ts",
] as const;

function runtimeEntries(): readonly string[] {
  const config = readFileSync(path.join(ROOT, "tsdown.config.ts"), "utf8");
  return [...config.matchAll(/"(src\/[^"]+\.tsx?)"/gu)]
    .map((match) => match[1] ?? "")
    .filter(
      (entry) => !TOOLING_SOURCES.some((prefix) => entry.startsWith(prefix)),
    );
}

/** Specifiers a file loads at run time; `import type` and type-only re-exports are erased. */
function runtimeSpecifiers(file: string, text: string): readonly string[] {
  const { module } = parseSync(file, text);
  const found: string[] = [];
  for (const entry of module.staticImports) {
    if (
      entry.entries.length === 0 ||
      entry.entries.some((item) => !item.isType)
    ) {
      found.push(entry.moduleRequest.value);
    }
  }
  for (const statement of module.staticExports) {
    for (const entry of statement.entries) {
      if (entry.moduleRequest !== null && !entry.isType) {
        found.push(entry.moduleRequest.value);
      }
    }
  }
  for (const entry of module.dynamicImports) {
    const quoted = text.slice(
      entry.moduleRequest.start,
      entry.moduleRequest.end,
    );
    const literal = /^["'`]([^"'`]+)["'`]$/u.exec(quoted);
    if (literal?.[1] !== undefined) {
      found.push(literal[1]);
    }
  }
  return found;
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
}

function leaksFrom(entry: string): readonly string[] {
  const leaks: string[] = [];
  const seen = new Set<string>();
  const queue = [path.join(ROOT, entry)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const relative = path.relative(ROOT, file);
    if (relative.startsWith("src/cli/")) {
      leaks.push(`${entry}: reaches ${relative}`);
      continue;
    }
    for (const specifier of runtimeSpecifiers(
      file,
      readFileSync(file, "utf8"),
    )) {
      if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(file), specifier);
        if (/\.tsx?$/u.test(target) && existsSync(target)) {
          queue.push(target);
        }
        continue;
      }
      const name = packageName(specifier);
      // SAFETY: widens the literal tuple so includes() accepts any package name
      if ((CLI_ONLY_PACKAGES as readonly string[]).includes(name)) {
        leaks.push(`${entry}: ${relative} imports ${name}`);
      }
    }
  }
  return leaks;
}

describe("invariant 12: runtime entries never load a CLI package", () => {
  it("finds the runtime entries", () => {
    expect(runtimeEntries()).toContain("src/index.ts");
    expect(runtimeEntries()).not.toContain("src/cli/index.ts");
  });

  it.each(runtimeEntries())("%s reaches no CLI source or package", (entry) => {
    expect(leaksFrom(entry)).toEqual([]);
  });
});
