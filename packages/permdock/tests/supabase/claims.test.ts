import type { StandardSchemaV1 } from "@standard-schema/spec";

import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  supabaseClaims,
  subjectFromSupabase,
} from "../../src/supabase/index.ts";
import { supabaseClaimFixtures } from "../../src/testing/supabase-fixtures.ts";

// SAFETY: supabase-claims-v1.json is the package's own JSON Schema, a top-level object.
const jsonSchema = JSON.parse(
  readFileSync(
    new URL("../../schemas/supabase-claims-v1.json", import.meta.url),
    "utf8",
  ),
) as object;
const ajv = new Ajv2020({ strict: false }).compile(jsonSchema);

function validate(
  schema: StandardSchemaV1,
  value: unknown,
): StandardSchemaV1.Result<unknown> {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    throw new TypeError("expected a synchronous result");
  }
  return result;
}

const sub = "6f1c2c1e-5d0a-4d9e-9a51-6b1f0e7c2a10";

const invalid: readonly (readonly [string, unknown])[] = [
  ["not an object", "claims"],
  ["an array", []],
  ["user_role number", { sub, user_role: 1 }],
  ["roles string", { sub, roles: "admin" }],
  ["memberships object", { sub, memberships: {} }],
  ["membership without roles", { sub, memberships: [{ tenant: "acme" }] }],
  [
    "membership empty roles",
    { sub, memberships: [{ tenant: "acme", roles: [] }] },
  ],
  ["membership unlocated", { sub, memberships: [{ roles: ["admin"] }] }],
  [
    "membership scope without id",
    { sub, memberships: [{ scope: "org", roles: ["a"] }] },
  ],
  [
    "membership within number",
    { sub, memberships: [{ tenant: "t", roles: ["a"], within: { org: 1 } }] },
  ],
  [
    "membership on without id",
    { sub, memberships: [{ on: { resource: "doc" }, roles: ["a"] }] },
  ],
  [
    "membership managedBy",
    { sub, memberships: [{ tenant: "t", roles: ["a"], managedBy: "scim" }] },
  ],
  [
    "membership expiresAt string",
    { sub, memberships: [{ tenant: "t", roles: ["a"], expiresAt: "1" }] },
  ],
  [
    "membership grants array",
    { sub, memberships: [{ tenant: "t", roles: ["a"], grants: [] }] },
  ],
  ["memberships_truncated string", { sub, memberships_truncated: "true" }],
  ["tenant_id number", { sub, tenant_id: 1 }],
  ["attrs array", { sub, attrs: [] }],
  ["authz_ver float", { sub, authz_ver: 1.5 }],
  ["client_id number", { sub, client_id: 1 }],
  ["scope number", { sub, scope: 1 }],
  ["act string", { sub, act: "agent" }],
  ["nested act sub number", { sub, act: { sub: "a", act: { sub: 2 } } }],
  ["act without sub", { sub, act: {} }],
  ["nested act empty sub", { sub, act: { sub: "a", act: { sub: "" } } }],
  ["act unknown kind", { sub, act: { sub: "a", kind: "root" } }],
  [
    "act support without session_id",
    { sub, act: { sub: "a", kind: "support" } },
  ],
  [
    "act support empty session_id",
    { sub, act: { sub: "a", kind: "support", session_id: "" } },
  ],
  [
    "act support read_only string",
    {
      sub,
      act: { sub: "a", kind: "support", session_id: "s", read_only: "y" },
    },
  ],
  [
    "act reason number",
    { sub, act: { sub: "a", kind: "impersonation", reason: 1 } },
  ],
  [
    "membership member without group",
    { sub, memberships: [{ tenant: "t", roles: ["a"], member: {} }] },
  ],
  [
    "membership member empty group",
    {
      sub,
      memberships: [{ tenant: "t", roles: ["a"], member: { group: "" } }],
    },
  ],
  ["app_metadata array", { sub, app_metadata: [] }],
  ["app_metadata user_role number", { sub, app_metadata: { user_role: 1 } }],
  [
    "app_metadata memberships malformed",
    { sub, app_metadata: { memberships: [{}] } },
  ],
];

describe("supabaseClaims()", () => {
  const schema = supabaseClaims();

  it("is a Standard Schema v1 from permdock", () => {
    expect(schema["~standard"].version).toBe(1);
    expect(schema["~standard"].vendor).toBe("permdock");
    expect(Object.isFrozen(schema)).toBe(true);
  });

  for (const [name, fixture] of Object.entries(supabaseClaimFixtures)) {
    it(`accepts the ${name} fixture, as the JSON Schema does`, () => {
      expect(validate(schema, fixture.claims)).toEqual({
        value: fixture.claims,
      });
      expect(ajv(fixture.claims)).toBe(true);
    });
  }

  for (const [name, value] of invalid) {
    it(`refuses ${name}, as the JSON Schema does`, () => {
      const result = validate(schema, value);
      expect(result.issues?.length ?? 0).toBeGreaterThan(0);
      expect(ajv(value)).toBe(false);
    });
  }

  it("accepts the member group a membership source fills, as the JSON Schema does", () => {
    const claims = {
      sub,
      memberships: [{ tenant: "t", roles: ["a"], member: { group: "night" } }],
    };
    expect(validate(schema, claims)).toEqual({ value: claims });
    expect(ajv(claims)).toBe(true);
  });

  it("passes unknown claims through unchanged", () => {
    const claims = { sub, datetime_preferences: { timezone: "UTC" }, x: [1] };
    expect(validate(schema, claims)).toEqual({ value: claims });
  });

  it("names the path of a bad membership field", () => {
    const result = validate(schema, {
      sub,
      memberships: [
        { tenant: "t", roles: ["a"] },
        { tenant: "t", roles: [1] },
      ],
    });
    expect(result.issues?.[0]?.path).toEqual(["memberships", 1, "roles"]);
  });

  it("reads the tenant claim the app configures", () => {
    const custom = supabaseClaims({ tenantClaim: "org_id" });
    expect(validate(custom, { sub, org_id: "acme" }).issues).toBeUndefined();
    expect(validate(custom, { sub, org_id: 1 }).issues).toHaveLength(1);
    expect(validate(custom, { sub, tenant_id: 1 }).issues).toBeUndefined();
    expect(
      validate(custom, { sub, app_metadata: { org_id: 2 } }).issues?.[0]?.path,
    ).toEqual(["app_metadata", "org_id"]);
    expect(() => supabaseClaims({ tenantClaim: "memberships" })).toThrow(
      /tenantClaim/,
    );
    expect(() => supabaseClaims({ tenantClaim: "" })).toThrow(/tenantClaim/);
  });

  it("agrees with subjectFromSupabase on what it maps", () => {
    for (const fixture of Object.values(supabaseClaimFixtures)) {
      const result = validate(schema, fixture.claims);
      const value = "value" in result ? result.value : undefined;
      expect(subjectFromSupabase(value, fixture.options)).toEqual(
        subjectFromSupabase(fixture.claims, fixture.options),
      );
    }
  });
});

describe("supabaseClaims().extend", () => {
  const full = supabaseClaimFixtures.full.claims;

  it("merges a Zod 4 schema over the base output", () => {
    const schema = supabaseClaims().extend(
      z.object({
        datetime_preferences: z.object({
          timezone: z.string(),
          week_start: z.enum(["monday", "sunday"]),
          date_format: z.string(),
          time_format: z.enum(["12h", "24h"]),
        }),
      }),
    );
    const result = validate(schema, full);
    expect(result.issues).toBeUndefined();
    expect("value" in result && result.value).toMatchObject({
      memberships: full["memberships"],
      datetime_preferences: full["datetime_preferences"],
    });
  });

  it("merges a valibot schema and chains", () => {
    const schema = supabaseClaims()
      .extend(v.looseObject({ authz_ver: v.number() }))
      .extend(v.object({ sub: v.pipe(v.string(), v.uuid()) }));
    expect(validate(schema, full).issues).toBeUndefined();
    expect(
      validate(schema, { ...full, sub: "not-a-uuid" }).issues,
    ).toHaveLength(1);
  });

  it("combines the issues of the base and the app schema", () => {
    const schema = supabaseClaims().extend(
      z.object({ datetime_preferences: z.object({ timezone: z.string() }) }),
    );
    const result = validate(schema, { sub, roles: "admin" });
    expect(result.issues?.map((item) => item.path?.[0])).toEqual([
      "roles",
      "datetime_preferences",
    ]);
  });

  it("awaits an async app schema", async () => {
    const schema = supabaseClaims().extend(
      z.object({ sub: z.string().refine(async (value) => value === sub) }),
    );
    await expect(schema["~standard"].validate({ sub })).resolves.toEqual({
      value: { sub },
    });
    await expect(
      schema["~standard"].validate({ sub: "other" }),
    ).resolves.toMatchObject({ issues: [{ path: ["sub"] }] });
  });

  it("refuses an app schema whose output is not an object", () => {
    const schema = supabaseClaims().extend(
      z
        .string()
        .optional()
        .transform(() => 1),
    );
    expect(validate(schema, { sub }).issues?.[0]?.message).toMatch(/object/);
  });

  it("refuses something that is not a Standard Schema", () => {
    // SAFETY: deliberately not a Standard Schema, to check the runtime guard.
    const notSchema = {} as StandardSchemaV1;
    expect(() => supabaseClaims().extend(notSchema)).toThrow(/Standard Schema/);
  });
});
