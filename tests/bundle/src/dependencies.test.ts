import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DIST,
  ENTRIES,
  RUNTIME_ENTRIES,
  TOOLING_PACKAGES,
  packageImports,
  walk,
} from "./graph.ts";

describe("invariant 12: runtime entries depend on @standard-schema/spec only", () => {
  it("never loads a CLI or test-runner package from a runtime entry", () => {
    const leaked: string[] = [];
    for (const entry of RUNTIME_ENTRIES) {
      for (const name of packageImports(walk(ENTRIES[entry]))) {
        // SAFETY: widens the literal tuple so includes() accepts any package name
        if ((TOOLING_PACKAGES as readonly string[]).includes(name)) {
          leaked.push(`${entry}: ${name}`);
        }
      }
    }
    expect(leaked).toStrictEqual([]);
  });

  it("keeps the core entry free of every package but optional peers", () => {
    expect(packageImports(walk(ENTRIES["."]))).toStrictEqual([]);
  });

  it("keeps permdock/testing/core free of vitest and every other package", () => {
    expect(packageImports(walk(ENTRIES["./testing/core"]))).toStrictEqual([]);
  });

  it("keeps the feature entries free of every vendor package", () => {
    for (const entry of [
      "./agent",
      "./workflow",
      "./delivery",
      "./chat",
    ] as const) {
      expect(packageImports(walk(ENTRIES[entry]))).toStrictEqual([]);
    }
  });

  it("declares only @standard-schema/spec, and jiti and oxc-parser as optional peers", () => {
    // SAFETY: dist/../package.json is the built package's own manifest
    const manifest = JSON.parse(
      readFileSync(join(DIST, "..", "package.json"), "utf8"),
    ) as {
      readonly dependencies: Readonly<Record<string, string>>;
      readonly peerDependencies: Readonly<Record<string, string>>;
      readonly peerDependenciesMeta: Readonly<
        Record<string, { readonly optional?: boolean }>
      >;
    };
    expect(Object.keys(manifest.dependencies)).toStrictEqual([
      "@standard-schema/spec",
    ]);
    for (const name of ["jiti", "oxc-parser"]) {
      expect(manifest.peerDependencies[name]).toBeTypeOf("string");
      expect(manifest.peerDependenciesMeta[name]?.optional).toBe(true);
    }
  });
});
