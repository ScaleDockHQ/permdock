import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

type Manifest = {
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
};

function manifestOf(specifier: string): Manifest {
  // SAFETY: a package.json read from disk has the Manifest shape
  return JSON.parse(
    readFileSync(require.resolve(specifier), "utf8"),
  ) as Manifest;
}

describe("CLI parser pins", () => {
  it("installs the same oxc-parser as better-supabase, so an app gets one copy", () => {
    const bsb = manifestOf("better-supabase/package.json");
    const own = manifestOf("oxc-parser/package.json");
    const theirs = bsb.dependencies?.["oxc-parser"];
    // A tarball install keeps better-supabase's catalog range; a registry install has the version.
    if (theirs !== undefined && !theirs.startsWith("catalog:")) {
      expect(own.version).toBe(theirs);
    }
    expect(own.version).toBe("0.159.0");
  });

  it("pins the three parsers exactly in the catalog", () => {
    const workspace = readFileSync(
      new URL("../../../../pnpm-workspace.yaml", import.meta.url),
      "utf8",
    );
    for (const name of ["oxc-parser", "pgsql-parser", "libpg-query"]) {
      expect(workspace).toMatch(
        new RegExp(`^  ${name}: \\d+\\.\\d+\\.\\d+$`, "mu"),
      );
    }
  });
});
