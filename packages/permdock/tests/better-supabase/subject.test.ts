import { describe, expect, it } from "vitest";

import type { SupabaseHookManifest } from "../../src/supabase/manifest.ts";

import { subjectFromBetterSupabase } from "../../src/better-supabase/index.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { testSubjectResolver } from "../../src/testing/conformance.ts";
import { supabaseHookManifestFixture } from "../../src/testing/supabase-fixtures.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const permissions = definePermissions({
  deal: resource({ actions: ["read", "write"] }),
});

const withApiKeys: SupabaseHookManifest = {
  ...supabaseHookManifestFixture,
  rls: {
    ...supabaseHookManifestFixture.rls,
    apiKeys: {
      claim: "api_key",
      scopes: "scopes",
      tenant: "tenant",
      roles: "roles",
      serviceRoles: ["integration"],
    },
  },
};

const session = (claims: Record<string, unknown>) => ({
  kind: "user",
  claims: { sub: USER, role: "authenticated", ...claims },
});

describe("subjectFromBetterSupabase", () => {
  it("reads memberships and the features claim as plans", () => {
    const subject = subjectFromBetterSupabase(
      session({
        tenant_id: ORG,
        memberships: [{ scope: "organization", id: ORG, roles: ["owner"] }],
        features: { [ORG]: ["exports"] },
      }),
    );
    expect(subject.principal).toMatchObject({
      id: USER,
      tenant: ORG,
      plans: ["exports"],
      memberships: [{ scope: "organization", id: ORG, roles: ["owner"] }],
    });
  });

  it("lets options override the defaults", () => {
    const subject = subjectFromBetterSupabase(
      session({ tenant_id: ORG, plans: { [ORG]: ["pro"] } }),
      { plans: "plans" },
    );
    expect(subject.principal).toMatchObject({ plans: ["pro"] });
  });

  it("decodes entitlements.claim.keys short codes back to feature keys", () => {
    const subject = subjectFromBetterSupabase(
      session({ tenant_id: ORG, features: { [ORG]: ["x", "?"] } }),
      { plans: { keys: { exports: "x", seats: "s" } } },
    );
    expect(subject.principal).toMatchObject({ plans: ["exports"] });
  });

  it("is anonymous without a user session", () => {
    expect(subjectFromBetterSupabase(null).principal).toBeNull();
    expect(subjectFromBetterSupabase({ kind: "anon" }).principal).toBeNull();
  });

  testSubjectResolver(
    (input: unknown) =>
      // SAFETY: the runner passes the invalid session below, which the resolver must refuse.
      subjectFromBetterSupabase(input as { kind: string }, {
        apiKeys: { permissions },
      }),
    { invalid: { kind: "invalid", reason: "expired" } },
  );
});

describe("subjectFromBetterSupabase with apiKey sessions", () => {
  const key = {
    kind: "apiKey",
    keyId: "33333333-3333-4333-8333-333333333333",
    name: "CI",
    organizationId: ORG,
    scopes: ["deal.read"],
    createdAt: 1_791_277_200,
  } as const;

  it("is anonymous without the apiKeys option", () => {
    expect(
      subjectFromBetterSupabase({ ...key, userId: USER }).principal,
    ).toBeNull();
  });

  it("maps a personal key to its user, narrowed to the key's scopes", () => {
    const subject = subjectFromBetterSupabase(
      { ...key, userId: USER },
      { apiKeys: { permissions } },
    );
    expect(subject.principal).toMatchObject({
      id: USER,
      kind: "user",
      tenant: ORG,
      credential: { id: key.keyId, permissions: [{ permission: "deal.read" }] },
    });
    expect(subject.delegation).toBeDefined();
  });

  it("maps a tenant key to a service principal with the manifest's roles", () => {
    expect(
      subjectFromBetterSupabase(key, { apiKeys: { permissions } }).principal,
    ).toBeNull();
    const subject = subjectFromBetterSupabase(key, {
      apiKeys: { permissions, manifest: withApiKeys },
    });
    expect(subject.principal).toMatchObject({
      id: key.keyId,
      kind: "service",
      memberships: [{ tenant: ORG, roles: ["integration"] }],
    });
    expect(
      subjectFromBetterSupabase(key, {
        apiKeys: { permissions, serviceRoles: () => ["auditor"] },
      }).principal,
    ).toMatchObject({ memberships: [{ roles: ["auditor"] }] });
  });

  it("expands * to every permission", () => {
    const subject = subjectFromBetterSupabase(
      { ...key, userId: USER, scopes: ["*"] },
      { apiKeys: { permissions } },
    );
    expect(subject.principal).toMatchObject({
      credential: {
        permissions: [
          { permission: "deal.read" },
          { permission: "deal.write" },
        ],
      },
    });
  });
});
