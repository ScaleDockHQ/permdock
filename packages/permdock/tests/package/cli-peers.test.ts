import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CLI = path.join(ROOT, "src", "cli");
const LOADER = path.join("src", "cli", "core", "optional.ts");
const OPTIONAL_PEERS = ["jiti", "oxc-parser"] as const;

function sources(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sources(file);
    }
    return file.endsWith(".ts") ? [file] : [];
  });
}

describe("CLI optional peers", () => {
  it.each(OPTIONAL_PEERS)(
    "%s is loaded only through core/optional.ts",
    (name) => {
      const runtimeImport = new RegExp(
        String.raw`^\s*import\s+(?!type\b)[^;]*from\s+["']${name}["']|import\(\s*["']${name}["']`,
        "mu",
      );
      const leaks = sources(CLI)
        .filter((file) => path.relative(ROOT, file) !== LOADER)
        .filter((file) => runtimeImport.test(readFileSync(file, "utf8")))
        .map((file) => path.relative(ROOT, file));
      expect(leaks).toStrictEqual([]);
    },
  );

  it("declares jiti and oxc-parser as optional peers and no regular dependency but the schema spec", () => {
    const manifest: {
      readonly dependencies: Record<string, string>;
      readonly peerDependencies: Record<string, string>;
      readonly peerDependenciesMeta: Record<
        string,
        { readonly optional?: boolean }
      >;
    } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(Object.keys(manifest.dependencies)).toStrictEqual([
      "@standard-schema/spec",
    ]);
    for (const name of OPTIONAL_PEERS) {
      expect(manifest.peerDependencies[name]).toBeTypeOf("string");
      expect(manifest.peerDependenciesMeta[name]?.optional).toBe(true);
    }
  });
});
