import {
  type BlockTransport,
  createApiKeys,
} from "better-supabase/blocks/api-keys";
import { Temporal } from "temporal-polyfill";
import { beforeAll, describe, expect, it } from "vitest";

import type { ApiKeyVerifierOptions } from "../../src/better-supabase/index.ts";
import type { Permission } from "../../src/core/permissions.ts";
import type { SupabaseHookManifest } from "../../src/supabase/manifest.ts";

import {
  apiKeyClaimOptions,
  apiKeyVerifier,
} from "../../src/better-supabase/index.ts";
import { testCredentialVerifier } from "../../src/testing/conformance.ts";
import { supabaseHookManifestFixture } from "../../src/testing/supabase-fixtures.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

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

// Node 24 ships no Temporal, which the api-keys block needs.
beforeAll(() => {
  if (!("Temporal" in globalThis)) Object.assign(globalThis, { Temporal });
});

const row = (extra: Record<string, unknown> = {}) => ({
  id: "33333333-3333-4333-8333-333333333333",
  organization_id: ORG,
  user_id: null,
  name: "CI",
  prefix: "pdk",
  public_id: "0123456789abcdef",
  scopes: ["deals.read"],
  rate_limit: 60,
  expires_at: null,
  last_used_at: "2026-10-06T10:00:00Z",
  revoked_at: null,
  rotated_from: null,
  created_by: USER,
  created_at: "2026-10-06T09:00:00Z",
  ...extra,
});

const transport = (answer: () => unknown): BlockTransport => ({
  call: async () => answer(),
});

const verifier = (
  key: Record<string, unknown>,
  options: Partial<ApiKeyVerifierOptions> = {},
) =>
  apiKeyVerifier({
    keys: createApiKeys({
      transport: transport(() => ({ status: "ok", key: row(key) })),
      prefix: "pdk",
    }),
    ...options,
  });

const token = async (): Promise<string> =>
  (
    await createApiKeys({ transport: transport(() => row()), prefix: "pdk" })
      .create({ name: "x", organizationId: ORG })
      .orThrow()
  ).token;

const permission = (key: string): Permission => ({
  key,
  scope: key,
  resource: "a",
  action: key,
  meta: {},
  kind: "instance",
});

describe("apiKeyVerifier", () => {
  it("maps a personal key to a user credential narrowed to its scopes and tenant", async () => {
    expect(
      await verifier({
        user_id: USER,
        expires_at: "2027-01-01T00:00:00Z",
      }).verify(await token()),
    ).toEqual({
      v: 1,
      id: "0123456789abcdef",
      kind: "user",
      principal: USER,
      tenant: ORG,
      permissions: [{ permission: "deals.read" }],
      createdBy: USER,
      createdAt: 1_791_277_200,
      expiresAt: 1_798_761_600,
      name: "CI",
    });
    const unlimited = await verifier({
      user_id: USER,
      organization_id: null,
    }).verify(await token());
    expect(unlimited).toMatchObject({
      permissions: [{ permission: "deals.read" }],
    });
    expect(unlimited).not.toHaveProperty("tenant");
  });

  it("maps a tenant key to a service credential only with its roles", async () => {
    expect(await verifier({}).verify(await token())).toBeNull();
    const expected = {
      kind: "service",
      principal: "0123456789abcdef",
      tenant: ORG,
      roles: ["integration"],
    };
    expect(
      await verifier({}, { serviceRoles: () => ["integration"] }).verify(
        await token(),
      ),
    ).toMatchObject(expected);
    expect(
      await verifier({}, { serviceRoles: ["integration"] }).verify(
        await token(),
      ),
    ).toMatchObject(expected);
  });

  it("expands * only with allPermissions", async () => {
    const all = { user_id: USER, scopes: ["*"] };
    expect(await verifier(all).verify(await token())).toBeNull();
    expect(
      await verifier(all, {
        allPermissions: [permission("a.read"), permission("a.write")],
      }).verify(await token()),
    ).toMatchObject({
      permissions: [{ permission: "a.read" }, { permission: "a.write" }],
    });
  });

  it("is null for a key that doesn't verify, a failed lookup or a bad record", async () => {
    const invalid = apiKeyVerifier({
      keys: createApiKeys({
        transport: transport(() => ({ status: "invalid" })),
        prefix: "pdk",
      }),
    });
    expect(await invalid.verify(await token())).toBeNull();
    expect(await invalid.verify("not a key")).toBeNull();
    const failing = apiKeyVerifier({
      keys: createApiKeys({
        transport: { call: () => Promise.reject(new Error("network")) },
        prefix: "pdk",
      }),
    });
    expect(await failing.verify(await token())).toBeNull();
    expect(
      await verifier({}, { serviceRoles: [""] }).verify(await token()),
    ).toBeNull();
  });

  it("expires a rotated key's credential when its grace period ends", async () => {
    const graceEnds = 1_798_761_600;
    expect(
      await verifier({
        user_id: USER,
        revoked_at: "2027-01-01T00:00:00Z",
        expires_at: "2028-01-01T00:00:00Z",
      }).verify(await token()),
    ).toMatchObject({ kind: "user", expiresAt: graceEnds });
    expect(
      await verifier({
        user_id: USER,
        revoked_at: "2027-01-01T00:00:00Z",
      }).verify(await token()),
    ).toMatchObject({ expiresAt: graceEnds });
    expect(
      await verifier({
        user_id: USER,
        revoked_at: "2028-01-01T00:00:00Z",
        expires_at: "2027-01-01T00:00:00Z",
      }).verify(await token()),
    ).toMatchObject({ expiresAt: graceEnds });
  });

  it("is null for a verified key that is neither active nor in grace", async () => {
    for (const state of ["revoked", "expired"]) {
      expect(
        await verifier({ user_id: USER, state }).verify(await token()),
      ).toBeNull();
    }
  });

  it("takes a tenant key's roles from the manifest's rls.apiKeys", async () => {
    expect(
      await verifier({}, { manifest: withApiKeys }).verify(await token()),
    ).toMatchObject({ kind: "service", roles: ["integration"] });
    expect(
      await verifier(
        {},
        { manifest: withApiKeys, serviceRoles: ["auditor"] },
      ).verify(await token()),
    ).toMatchObject({ roles: ["auditor"] });
  });
});

describe("apiKeyVerifier conformance", () => {
  const stored = new Map<string, { hash: string; revoked: boolean }>();
  const keys = createApiKeys({
    prefix: "pdk",
    transport: {
      call: async (_schema, fn, args) => {
        const publicId = String(args["public_id"]);
        if (fn === "create_api_key") {
          stored.set(publicId, {
            hash: String(args["secret_hash"]),
            revoked: false,
          });
          return row({ public_id: publicId, user_id: USER });
        }
        if (fn === "revoke_api_key") {
          for (const entry of stored.values()) entry.revoked = true;
          return true;
        }
        const entry = stored.get(publicId);
        return entry !== undefined &&
          !entry.revoked &&
          entry.hash === args["secret_hash"]
          ? { status: "ok", key: row({ public_id: publicId, user_id: USER }) }
          : { status: "invalid" };
      },
    },
  });
  testCredentialVerifier(apiKeyVerifier({ keys }), {
    key: async () =>
      (await keys.create({ name: "CI", organizationId: ORG }).orThrow()).token,
    revoke: async () => {
      await keys.revoke("33333333-3333-4333-8333-333333333333").orThrow();
    },
  });
});

describe("apiKeyClaimOptions", () => {
  it("reads rls.apiKeys and the tenant claim", () => {
    expect(apiKeyClaimOptions(withApiKeys)).toEqual({
      claim: {
        name: "api_key",
        scopes: "scopes",
        tenant: "tenant",
        roles: "roles",
        serviceRoles: ["integration"],
      },
      tenantClaim: "tenant_id",
    });
  });

  it("throws without rls.apiKeys", () => {
    expect(() => apiKeyClaimOptions(supabaseHookManifestFixture)).toThrow(
      /has no rls.apiKeys/u,
    );
  });
});
