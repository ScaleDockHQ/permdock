import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CLIENT_ENTRIES,
  ENTRIES,
  NEUTRAL_FOLDERS,
  SERVER_FOLDERS,
} from "./graph.ts";

const PACKAGE = new URL("../../../packages/permdock/", import.meta.url);

type Manifest = {
  readonly exports: Readonly<Record<string, { readonly default?: string }>>;
};

// SAFETY: packages/permdock/package.json is the package's own manifest; exports map entries to conditions.
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("package.json", PACKAGE)), "utf8"),
) as Manifest;

const tsdownEntries = new Set(
  [
    ...readFileSync(
      fileURLToPath(new URL("tsdown.config.ts", PACKAGE)),
      "utf8",
    ).matchAll(/"src\/([\w/-]+)\.tsx?"/gu),
  ].map((match) => `${match[1] ?? ""}.js`),
);

const exported = Object.entries(manifest.exports).filter(
  ([entry]) => entry !== "./package.json",
);

describe("every package entry is listed everywhere a gate reads it", () => {
  it("graph.ts ENTRIES matches package.json exports", () => {
    expect(ENTRIES).toEqual(
      Object.fromEntries(
        exported.map(([entry, target]) => [
          entry,
          (target.default ?? "").replace(/^\.\/dist\//u, ""),
        ]),
      ),
    );
  });

  it("every export is a tsdown entry", () => {
    const missing = Object.values(ENTRIES).filter(
      (file) => !tsdownEntries.has(file),
    );
    expect(missing).toEqual([]);
  });

  it("every entry folder is classified as server, client or neutral", () => {
    const client = new Set(
      CLIENT_ENTRIES.map((entry) => ENTRIES[entry].split("/")[0]),
    );
    const server = new Set<string>(SERVER_FOLDERS);
    const neutral = new Set<string>(NEUTRAL_FOLDERS);
    const unclassified = Object.entries(ENTRIES)
      .filter(([entry]) => entry !== ".")
      .map(([, file]) => file.split("/")[0] ?? "")
      .filter(
        (folder) =>
          !server.has(folder) && !client.has(folder) && !neutral.has(folder),
      );
    expect(unclassified).toEqual([]);
  });
});
