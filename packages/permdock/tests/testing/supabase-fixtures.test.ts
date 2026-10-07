import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { supabaseHookManifest } from "../../src/cli/supabase-hook.ts";
import { defineScopes } from "../../src/core/scopes.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  fromSnapshot,
  resource,
  snapshotFor,
} from "../../src/index.ts";
import {
  fromJunction,
  fromTable,
  subjectFromSupabase,
  subjectFromSupabaseSession,
} from "../../src/supabase/index.ts";
import {
  supabaseClaimFixtures,
  supabaseClaimVectors,
  supabaseHookManifestFixture,
  supabaseMembershipsBudget,
} from "../../src/testing/supabase-fixtures.ts";
import { policy as liveSessionPolicy } from "../fixtures/live-session.ts";

const permissions = definePermissions({
  post: resource({ collection: ["list", "moderate"] }),
  org: resource({ collection: ["manage"] }),
});
const roles = defineRoles({
  admin: {},
  moderator: {},
  orgAdmin: { on: "tenant" },
  viewer: { on: "tenant" },
});
const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { tenant: { key: "orgId" } },
    subject: (claims: unknown) => subjectFromSupabase(claims).principal,
    grants: [
      allow(permissions.post.moderate, { to: [roles.admin] }),
      allow(permissions.post.moderate, { to: [roles.moderator] }),
      allow(permissions.org.manage, { to: roles.orgAdmin }),
      allow(permissions.post.list, { to: roles.viewer }),
      allow(permissions.post.list, { to: roles.orgAdmin }),
    ],
  },
);

const multiOrgClaims = {
  ...supabaseClaimFixtures.multiOrg.claims,
  memberships: [
    { tenant: "acme", roles: ["orgAdmin"] },
    { tenant: "globex", roles: ["viewer"] },
  ],
};

function memberships(count: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      tenant: `8f14e45f-ceea-467a-9575-3c7e4a1b${String(index).padStart(4, "0")}`,
      roles: ["admin"],
    })),
  );
}

describe("Supabase RBAC hook claims", () => {
  for (const [name, fixture] of Object.entries(supabaseClaimFixtures)) {
    it(`maps ${name}`, () => {
      const subject = subjectFromSupabase(fixture.claims, fixture.options);
      expect(subject.principal?.id ?? null).toBe(fixture.expect.id);
      if (subject.principal === null) {
        expect(subject.actor).toBeUndefined();
        return;
      }
      expect(subject.actor).toEqual(fixture.expect.actor);
      expect(subject.delegation).toEqual(fixture.expect.delegation);
      expect(subject.principal.roles ?? []).toEqual(fixture.expect.roles);
      expect(subject.principal.memberships ?? []).toEqual(
        fixture.expect.memberships,
      );
      if ("tenant" in fixture.expect) {
        expect(subject.principal.tenant).toBe(fixture.expect.tenant);
      }
      expect(subject.principal.plans).toEqual(fixture.expect.plans);
      expect(subject.expiresAt).toBe(fixture.claims["exp"]);
    });
  }

  it("maps a structural session and treats every other kind as anonymous", () => {
    const claims = supabaseClaimFixtures.topLevelRole.claims;
    const session = { kind: "user", claims, user: {} };
    expect(subjectFromSupabaseSession(session).principal?.roles).toEqual([
      "admin",
    ]);
    for (const kind of ["anon", "service", "invalid", "USER"]) {
      expect(subjectFromSupabaseSession({ kind, claims }).principal).toBeNull();
    }
    expect(subjectFromSupabaseSession(null).principal).toBeNull();
    expect(
      subjectFromSupabaseSession({ kind: "user", claims: "nope" }).principal,
    ).toBeNull();
  });

  it("builds snapshots from hook claims", () => {
    const topLevel = fromSnapshot(
      snapshotFor(policy, supabaseClaimFixtures.topLevelRole.claims),
    );
    const fallback = fromSnapshot(
      snapshotFor(policy, supabaseClaimFixtures.nullTopLevelFallsBack.claims),
    );
    const missing = fromSnapshot(
      snapshotFor(policy, supabaseClaimFixtures.missingRole.claims),
    );
    const metadata = fromSnapshot(
      snapshotFor(policy, supabaseClaimFixtures.userMetadataIgnored.claims),
    );
    expect(topLevel.can(permissions.post.moderate)).toBe(true);
    expect(fallback.can(permissions.post.moderate)).toBe(true);
    expect(missing.can(permissions.post.moderate)).toBe(false);
    expect(metadata.can(permissions.post.moderate)).toBe(false);

    const acme = fromSnapshot(
      snapshotFor(policy, multiOrgClaims, { tenant: "acme" }),
    );
    const globex = fromSnapshot(
      snapshotFor(policy, multiOrgClaims, { tenant: "globex" }),
    );
    expect(acme.can(permissions.org.manage)).toBe(true);
    expect(globex.can(permissions.org.manage)).toBe(false);
    expect(globex.can(permissions.post.list)).toBe(true);
  });

  it("documents the memberships claim budget", () => {
    expect(memberships(15).length).toBeLessThanOrEqual(
      supabaseMembershipsBudget,
    );
    expect(memberships(16).length).toBeGreaterThan(supabaseMembershipsBudget);
  });
});

describe("supabaseHookManifestFixture", () => {
  it("is what supabase inspect prints for one tenant scope and a features claim", () => {
    const manifest = supabaseHookManifest(
      defineScopes({ tenant: { key: "orgId" } }),
      {
        permissions: "./policy.ts",
        supabase: {
          hook: {
            memberships: [fromTable({ table: "memberships" })],
            claims: { features: "better_supabase.feature_claims" },
          },
        },
      },
    );
    expect(manifest).toEqual(supabaseHookManifestFixture);
  });
});

describe("supabase-claims-v1.json", () => {
  // SAFETY: supabase-claims-v1.json is the package's own JSON Schema, a top-level object.
  const validate = new Ajv2020({ strict: false }).compile(
    JSON.parse(
      readFileSync(
        new URL("../../schemas/supabase-claims-v1.json", import.meta.url),
        "utf8",
      ),
    ) as object,
  );

  it("accepts every claim fixture and the hook output shape", () => {
    for (const [name, fixture] of Object.entries(supabaseClaimFixtures)) {
      expect([name, validate(fixture.claims)]).toEqual([name, true]);
    }
  });

  it("refuses a membership the reader would drop", () => {
    expect(validate({ memberships: [{ org_id: "o1", role: "admin" }] })).toBe(
      false,
    );
    expect(
      validate({ memberships: [{ scope: "tenant", id: "o1", roles: [] }] }),
    ).toBe(false);
  });
});

describe("supabase-manifest-v1.json", () => {
  // SAFETY: supabase-manifest-v1.json is the package's own JSON Schema, a top-level object.
  const validate = new Ajv2020({ strict: false }).compile(
    JSON.parse(
      readFileSync(
        new URL("../../schemas/supabase-manifest-v1.json", import.meta.url),
        "utf8",
      ),
    ) as object,
  );

  it("accepts the fixture and a manifest with junction sources, attrs and scope types", () => {
    validate(supabaseHookManifestFixture);
    expect(validate.errors ?? []).toEqual([]);
    const manifest = supabaseHookManifest(
      defineScopes({
        organization: { key: "organization_id" },
        customer: { key: "customer_id", within: "organization" },
      }),
      {
        permissions: "./policy.ts",
        rls: { authorize: "database", scopeTypes: { customer: "bigint" } },
        supabase: {
          hook: {
            memberships: [
              fromTable({
                table: "memberships",
                columns: { via: "via", expiresAt: "expires_at" },
              }),
              fromJunction({
                table: "billing.customer_contacts",
                scope: "customer",
                within: { organization: "organization_id" },
                roles: "role",
                via: "contact",
              }),
              fromJunction({
                table: "customer_contacts",
                scope: "customer",
                within: { organization: "organization_id" },
                user: {
                  through: "contact_profiles",
                  on: { contact_profile_id: "id" },
                  column: "user_id",
                },
                roles: {
                  through: "roles",
                  on: { role_id: "id" },
                  column: "key",
                },
                via: "contact",
              }),
            ],
            attrs: { table: "profiles", columns: ["locale"] },
          },
        },
      },
    );
    validate(manifest);
    expect(validate.errors ?? []).toEqual([]);
  });

  it("refuses an unknown helper, mode or value shape", () => {
    const helpers = {
      ...supabaseHookManifestFixture.helpers,
      functions: ["authorize"],
    };
    expect(validate({ ...supabaseHookManifestFixture, helpers })).toBe(false);
    const rls = { ...supabaseHookManifestFixture.rls, mode: "cookie" };
    expect(validate({ ...supabaseHookManifestFixture, rls })).toBe(false);
    const sources = [
      {
        ...supabaseHookManifestFixture.memberships[0],
        role: { column: "role", value: "admin" },
      },
    ];
    expect(
      validate({ ...supabaseHookManifestFixture, memberships: sources }),
    ).toBe(false);
    const { markers: _markers, ...unmarked } = supabaseHookManifestFixture;
    expect(validate(unmarked)).toBe(false);
    const requires = { matrix: "v1", capabilities: ["auth.get_claims"] };
    expect(validate({ ...supabaseHookManifestFixture, requires })).toBe(false);
  });
});

describe("manifest requires", () => {
  const scopes = defineScopes({ organization: { key: "organization_id" } });
  const hook = { memberships: [fromTable({ table: "memberships" })] };
  const read = { key: "asset.read" };

  it("adds the Realtime and Storage features the configured policies use", () => {
    const manifest = supabaseHookManifest(scopes, {
      permissions: "./policy.ts",
      rls: {
        realtime: { topics: { "org:{organization}": { read } } },
        storage: {
          buckets: {
            files: { scope: "organization", read, delete: read },
            uploads: { scope: "organization", write: read },
          },
        },
      },
      supabase: { hook },
    });
    expect(manifest.requires).toEqual({
      matrix: "capability-matrix-v1.12.0",
      capabilities: [
        "auth.session.get_claims",
        "realtime.subscriptions.private_channel",
        "storage.file_buckets.download",
        "storage.file_buckets.list_files",
        "storage.file_buckets.move",
        "storage.file_buckets.remove",
        "storage.file_buckets.update_file",
        "storage.file_buckets.upload",
      ],
    });
  });

  it("adds auth.session.get_user for a live-session grant", () => {
    const manifest = supabaseHookManifest(
      defineScopes({ organization: { key: "organization_id" } }),
      { permissions: "./policy.ts", supabase: { hook } },
      {},
      liveSessionPolicy,
    );
    expect(manifest.requires?.capabilities).toEqual([
      "auth.session.get_claims",
      "auth.session.get_user",
    ]);
  });
});

describe("supabaseClaimVectors", () => {
  // SAFETY: the fixture is supabase/sdk's conformance.schema.json, a top-level object.
  const validate = new Ajv2020({ strict: false }).compile(
    JSON.parse(
      readFileSync(
        new URL("../fixtures/sdk-conformance.schema.json", import.meta.url),
        "utf8",
      ),
    ) as object,
  );

  it("is a supabase/sdk conformance vector file", () => {
    validate(JSON.parse(JSON.stringify(supabaseClaimVectors)));
    expect(validate.errors ?? []).toEqual([]);
  });

  it("carries every claim fixture, and each maps to its expected subject", () => {
    expect(supabaseClaimVectors.cases.map((entry) => entry.name)).toEqual(
      Object.keys(supabaseClaimFixtures),
    );
    for (const { name, input, expected } of supabaseClaimVectors.cases) {
      const subject = subjectFromSupabase(input.claims, input.options);
      expect([name, subject.principal?.id ?? null]).toEqual([
        name,
        expected.id,
      ]);
      expect([name, subject.principal?.roles ?? []]).toEqual([
        name,
        expected.roles,
      ]);
    }
  });
});
