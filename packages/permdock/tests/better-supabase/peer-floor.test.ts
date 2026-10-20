import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SOURCE = path.join(ROOT, "src/better-supabase");
const WORKSPACE = path.resolve(ROOT, "../../pnpm-workspace.yaml");
const require = createRequire(path.join(ROOT, "package.json"));

/** An oxc-parser name kind, a string `const enum` member, as a plain string. */
const kindOf = (name: { readonly kind: unknown }): string => String(name.kind);

type Imported = {
  readonly file: string;
  readonly specifier: string;
  readonly name: string;
};

/** Every named import from `better-supabase` or one of its subpaths, types included. */
function importsOf(file: string, text: string): readonly Imported[] {
  return parseSync(file, text).module.staticImports.flatMap((entry) => {
    const specifier = entry.moduleRequest.value;
    if (
      specifier !== "better-supabase" &&
      !specifier.startsWith("better-supabase/")
    ) {
      return [];
    }
    return entry.entries.flatMap((item) =>
      kindOf(item.importName) === "Name" && item.importName.name !== null
        ? [{ file, specifier, name: item.importName.name }]
        : [],
    );
  });
}

/** The `types` path of an `exports` entry, through nested conditions. */
function typesPath(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return entry.endsWith(".d.ts") ? entry : undefined;
  }
  if (entry === null || typeof entry !== "object") {
    return undefined;
  }
  for (const [condition, value] of Object.entries(entry)) {
    if (condition === "types" && typeof value === "string") {
      return value;
    }
    const nested = typesPath(value);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

/** The names a declaration file exports, following `export *` into relative files. */
function exportedNames(file: string, seen = new Set<string>()): Set<string> {
  const names = new Set<string>();
  if (seen.has(file) || !existsSync(file)) {
    return names;
  }
  seen.add(file);
  const record = parseSync(file, readFileSync(file, "utf8")).module;
  for (const statement of record.staticExports) {
    for (const entry of statement.entries) {
      if (
        kindOf(entry.exportName) === "Name" &&
        entry.exportName.name !== null
      ) {
        names.add(entry.exportName.name);
      }
      const from = entry.moduleRequest?.value;
      if (
        kindOf(entry.importName) === "AllButDefault" &&
        from?.startsWith(".") === true
      ) {
        const target = path.join(
          path.dirname(file),
          from.replace(/\.js$/u, ".d.ts"),
        );
        for (const name of exportedNames(target, seen)) {
          names.add(name);
        }
      }
    }
  }
  return names;
}

/** The imports whose name the package at `root` does not export from that specifier. */
function missingImports(
  imports: readonly Imported[],
  root: string,
): readonly string[] {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const exportsMap =
    manifest !== null && typeof manifest === "object" && "exports" in manifest
      ? manifest.exports
      : undefined;
  const cache = new Map<string, Set<string>>();
  return imports.flatMap((item) => {
    const subpath =
      item.specifier === "better-supabase"
        ? "."
        : `.${item.specifier.slice("better-supabase".length)}`;
    let names = cache.get(subpath);
    if (names === undefined) {
      const entry =
        exportsMap !== null && typeof exportsMap === "object"
          ? Object.entries(exportsMap).find(([key]) => key === subpath)?.[1]
          : undefined;
      const types = typesPath(entry);
      names =
        types === undefined ? new Set() : exportedNames(path.join(root, types));
      cache.set(subpath, names);
    }
    return names.has(item.name)
      ? []
      : [`${item.file}: ${item.name} from ${item.specifier}`];
  });
}

/** The lowest version the `better-supabase` peer range accepts; `tests/package/better-supabase-peer-range.test.ts` checks it against the CI matrices. */
function peerFloor(): string | undefined {
  return /^\s+better-supabase: ">=([^\s"]+)/mu.exec(
    readFileSync(WORKSPACE, "utf8"),
  )?.[1];
}

/**
 * The installed package the check reads: `better-supabase-floor`, an alias
 * pinned to the lowest version of the peer range, so the check holds after the
 * `better-supabase` dev dependency moves on.
 */
function floorRoot(): string {
  return path.dirname(require.resolve("better-supabase-floor/package.json"));
}

const sources = readdirSync(SOURCE)
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({
    file: `src/better-supabase/${file}`,
    text: readFileSync(path.join(SOURCE, file), "utf8"),
  }));

describe("better-supabase peer floor", () => {
  it("declares a 0.11 floor", () => {
    expect(peerFloor()).toBe("0.11.0");
  });

  it("imports only names the lowest peer version exports", () => {
    const imports = sources.flatMap(({ file, text }) => importsOf(file, text));
    expect(imports.length).toBeGreaterThan(0);
    expect(missingImports(imports, floorRoot())).toEqual([]);
  });

  it("reports a name the peer does not export", () => {
    const imports = importsOf(
      "fixture.ts",
      `import type { AuthorizationProvider, NotInBetterSupabase } from "better-supabase/config";
import { gone } from "better-supabase/no-such-entry";`,
    );
    expect(missingImports(imports, floorRoot())).toEqual([
      "fixture.ts: NotInBetterSupabase from better-supabase/config",
      "fixture.ts: gone from better-supabase/no-such-entry",
    ]);
  });
});
