import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { catalogFingerprint } from "../../src/index.ts";
import {
  betterSupabaseCatalog,
  betterSupabaseManifest,
} from "../../src/testing/fixtures/index.ts";

const EXAMPLE = new URL(
  "../../../../apps/examples/next-better-supabase/",
  import.meta.url,
);

function exampleJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, EXAMPLE), "utf8"));
}

describe("permdock/testing/fixtures", () => {
  it("is the next-better-supabase catalog, parsed, with its own fingerprint", () => {
    expect(betterSupabaseCatalog).toEqual(
      exampleJson("permissions.catalog.json"),
    );
    expect(catalogFingerprint(betterSupabaseCatalog)).toBe(
      betterSupabaseCatalog.fingerprint,
    );
  });

  it("is the next-better-supabase manifest, parsed", () => {
    expect(betterSupabaseManifest).toEqual(
      exampleJson("permdock.manifest.json"),
    );
  });
});
