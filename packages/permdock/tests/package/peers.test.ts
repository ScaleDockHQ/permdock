import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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

const workspace: unknown = parse(
  readFileSync(
    new URL("../../../../pnpm-workspace.yaml", import.meta.url),
    "utf8",
  ),
);

/** The `peers` catalog of `pnpm-workspace.yaml`, or `{}` when it is missing. */
function peerCatalog(): Record<string, unknown> {
  const catalogs: unknown =
    workspace !== null && typeof workspace === "object"
      ? Reflect.get(workspace, "catalogs")
      : undefined;
  const peers: unknown =
    catalogs !== null && typeof catalogs === "object"
      ? Reflect.get(catalogs, "peers")
      : undefined;
  return peers !== null && typeof peers === "object"
    ? Object.fromEntries(Object.entries(peers))
    : {};
}

/** A range that is one or more `>=` floors joined by `||` (decision 0044). */
const FLOOR = /^>=\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/u;

function isFloor(range: unknown): boolean {
  return (
    typeof range === "string" &&
    range.split("||").every((part) => FLOOR.test(part.trim()))
  );
}

describe("peer dependencies", () => {
  it("marks every peer optional, because the main entry imports none of them", () => {
    const required = Object.keys(manifest.peerDependencies ?? {}).filter(
      (name) => manifest.peerDependenciesMeta?.[name]?.optional !== true,
    );
    expect(required).toStrictEqual([]);
  });

  it("declares metadata only for declared peers", () => {
    const peers = new Set(Object.keys(manifest.peerDependencies ?? {}));
    const extra = Object.keys(manifest.peerDependenciesMeta ?? {}).filter(
      (name) => !peers.has(name),
    );
    expect(extra).toStrictEqual([]);
  });

  it("takes every peer range from the peers catalog", () => {
    const outside = Object.entries(manifest.peerDependencies ?? {}).filter(
      ([, range]) => range !== "catalog:peers",
    );
    expect(outside).toStrictEqual([]);
  });

  it("gives every peer a floor and no upper bound", () => {
    const catalog = peerCatalog();
    expect(Object.keys(catalog).length).toBeGreaterThan(0);
    const capped = Object.entries(catalog).filter(
      ([, range]) => !isFloor(range),
    );
    expect(capped).toStrictEqual([]);
  });

  it.each(["^6", "~1.2.0", ">=0.11.0 <0.13.0", "1.2.3", "*", ">=1 <2 || >=3"])(
    "rejects %j as a peer range",
    (range) => {
      expect(isFloor(range)).toBe(false);
    },
  );

  it.each([">=6", ">=0.13.0", ">=2.0.0-0", ">=0.40 || >=1.0.0-rc.0"])(
    "accepts %j as a peer range",
    (range) => {
      expect(isFloor(range)).toBe(true);
    },
  );
});
