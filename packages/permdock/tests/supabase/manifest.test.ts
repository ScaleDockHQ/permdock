import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PermDockValidationError } from "../../src/core/validation-error.ts";
import { parseSupabaseManifest } from "../../src/supabase/index.ts";
import { supabaseManifestSchema } from "../../src/supabase/manifest-schema.ts";
import { supabaseHookManifestFixture } from "../../src/testing/supabase-fixtures.ts";

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

describe("parseSupabaseManifest", () => {
  it("shares its schema with schemas/supabase-manifest-v1.json", () => {
    expect(read("../../schemas/supabase-manifest-v1.json")).toEqual(
      supabaseManifestSchema,
    );
  });

  it("reads the fixture and the committed example manifest", () => {
    expect(parseSupabaseManifest(supabaseHookManifestFixture)).toEqual(
      supabaseHookManifestFixture,
    );
    const example = read(
      "../../../../apps/examples/next-better-supabase/permdock.manifest.json",
    );
    expect(parseSupabaseManifest(example)).toEqual(example);
    expect(parseSupabaseManifest(JSON.stringify(example))).toEqual(example);
  });

  it("returns a frozen copy", () => {
    const manifest = parseSupabaseManifest(supabaseHookManifestFixture);
    expect(manifest).not.toBe(supabaseHookManifestFixture);
    expect(Object.isFrozen(manifest.rls.scopes)).toBe(true);
  });

  it("refuses another major, a missing field and an unknown property", () => {
    const cases: readonly [unknown, RegExp][] = [
      [
        { ...supabaseHookManifestFixture, version: 2 },
        /at version: Expected 1/u,
      ],
      [
        { ...supabaseHookManifestFixture, markers: undefined },
        /at markers: Required/u,
      ],
      [
        {
          ...supabaseHookManifestFixture,
          rls: {
            ...supabaseHookManifestFixture.rls,
            suspension: { owners: {} },
          },
        },
        /at rls\.suspension\.owners: Unexpected property/u,
      ],
      ["{", /Expected JSON text/u],
    ];
    for (const [input, message] of cases) {
      const json =
        typeof input === "string" ? input : JSON.parse(JSON.stringify(input));
      expect(() => parseSupabaseManifest(json)).toThrow(message);
    }
    expect(() =>
      parseSupabaseManifest({ ...supabaseHookManifestFixture, version: 2 }),
    ).toThrow(PermDockValidationError);
  });

  it("checks minItems and uniqueItems", () => {
    expect(() =>
      parseSupabaseManifest({
        ...supabaseHookManifestFixture,
        requires: {
          matrix: "capability-matrix-v1.0.0",
          capabilities: ["auth.session.get_claims", "auth.session.get_claims"],
        },
      }),
    ).toThrow(/Expected unique items/u);
    const [membership] = supabaseHookManifestFixture.memberships;
    expect(() =>
      parseSupabaseManifest({
        ...supabaseHookManifestFixture,
        memberships: [{ ...membership, role: [{ column: "role" }] }],
      }),
    ).toThrow(/at memberships\.0\.role: Expected exactly one matching form/u);
  });
});
