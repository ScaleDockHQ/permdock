import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Manifest = {
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<
    string,
    { readonly optional?: boolean }
  >;
};

const manifest: Manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

describe("peer dependencies", () => {
  it("marks every peer optional, because the main entry imports none of them", () => {
    const required = Object.keys(manifest.peerDependencies ?? {}).filter(
      (name) => manifest.peerDependenciesMeta?.[name]?.optional !== true,
    );
    expect(required).toEqual([]);
  });

  it("declares metadata only for declared peers", () => {
    const peers = new Set(Object.keys(manifest.peerDependencies ?? {}));
    const extra = Object.keys(manifest.peerDependenciesMeta ?? {}).filter(
      (name) => !peers.has(name),
    );
    expect(extra).toEqual([]);
  });
});
