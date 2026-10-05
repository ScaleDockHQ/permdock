import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ADAPTER_SPECIFIERS,
  SERVER_SPECIFIERS,
} from "../../src/cli/doctor-source.ts";

/** Entries a client component may import: the definitions, client stores and wire readers. */
const CLIENT_SAFE = new Set([
  "permdock",
  "permdock/catalog",
  "permdock/next/client",
  "permdock/react",
  "permdock/react-native",
  "permdock/solid",
  "permdock/svelte",
  "permdock/vue",
  "permdock/webmcp",
]);

/** Build- and test-time entries no application file imports at run time. */
const TOOLING = new Set([
  "permdock/cli",
  "permdock/next/plugin",
  "permdock/testing",
  "permdock/testing/saas",
  "permdock/testing/saas/permissions",
  "permdock/unplugin",
]);

function entries(): readonly string[] {
  // SAFETY: package.json is this package's manifest; only the exports keys are read.
  const manifest = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "../../package.json"), "utf8"),
  ) as { readonly exports: Readonly<Record<string, unknown>> };
  return Object.keys(manifest.exports)
    .filter((entry) => entry !== "./package.json")
    .map((entry) =>
      entry === "." ? "permdock" : `permdock/${entry.slice(2)}`,
    );
}

describe("doctor entry lists follow package.json exports", () => {
  it("PD001 lists every server-only entry", () => {
    const serverOnly = entries().filter(
      (entry) => !CLIENT_SAFE.has(entry) && !TOOLING.has(entry),
    );
    expect([...SERVER_SPECIFIERS].toSorted()).toEqual(serverOnly.toSorted());
  });

  it("PD007 lists only package entries", () => {
    const known = new Set(entries());
    expect(ADAPTER_SPECIFIERS.filter((entry) => !known.has(entry))).toEqual([]);
  });
});
