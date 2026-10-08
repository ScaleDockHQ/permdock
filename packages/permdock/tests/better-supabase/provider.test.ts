import { testAuthorizationProvider } from "better-supabase/testing";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { SupabaseHookManifest } from "../../src/supabase/manifest.ts";

import { authorizationProvider } from "../../src/better-supabase/index.ts";
import { PermDockValidationError } from "../../src/core/validation-error.ts";
import { supabaseHookManifestFixture } from "../../src/testing/supabase-fixtures.ts";

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const EXAMPLE = "../../../../apps/examples/next-better-supabase/";
const exampleManifest = read(`${EXAMPLE}permdock.manifest.json`);
const exampleCatalog = read(`${EXAMPLE}permissions.catalog.json`);

const withRls = (
  rls: Partial<SupabaseHookManifest["rls"]>,
): SupabaseHookManifest => ({
  ...supabaseHookManifestFixture,
  rls: { ...supabaseHookManifestFixture.rls, ...rls },
});

describe("authorizationProvider", () => {
  it("passes better-supabase's conformance kit for the fixture", async () => {
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
    });
    await expect(testAuthorizationProvider(provider)).resolves.toBeDefined();
    expect(provider).toMatchObject({
      apiVersion: 1,
      name: "PermDock",
      scopes: [{ name: "tenant", idType: "uuid" }],
      tenantScope: "tenant",
      functions: {
        idsWith: "permdock.permitted_{scope}_ids({permission})",
        isPlatform: "permdock.permdock_has({permission})",
        memberIds: "permdock.member_{scope}_ids()",
        memberIdsFor: "permdock.member_{scope}_ids_for({user})",
      },
      memberships: [
        {
          table: "public.memberships",
          userColumn: "user_id",
          scope: { column: "scope" },
          idColumn: "scope_id",
        },
      ],
      decidingColumns: supabaseHookManifestFixture.decidingColumns,
    });
    expect(provider.functions.idsWithFor).toBeUndefined();
    expect(provider.functions.canAssign).toBeUndefined();
    expect(provider.permissions).toBeUndefined();
    expect(provider.problems).toBeUndefined();
    expect(Object.isFrozen(provider.functions)).toBe(true);
  });

  it("lists every helper with its argument types and calling role", () => {
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
    });
    expect(provider.requires).toEqual([
      {
        function: "permdock.permitted_tenant_ids",
        args: "text",
        role: "authenticated",
      },
      {
        function: "permdock.permdock_has",
        args: "text",
        role: "authenticated",
      },
      { function: "permdock.member_tenant_ids", role: "authenticated" },
      {
        function: "permdock.member_tenant_ids_for",
        args: "uuid",
        role: "supabase_auth_admin",
      },
    ]);
  });

  it("describes the token hook from the manifest's claims", () => {
    const { tokenHook } = authorizationProvider({
      manifest: supabaseHookManifestFixture,
    });
    expect(tokenHook).toEqual({
      function: "permdock.custom_access_token_hook",
      tenantClaim: "tenant_id",
      ownedClaims: [
        "user_role",
        "roles",
        "memberships",
        "memberships_truncated",
        "tenant_id",
        "authz_ver",
      ],
      registeredClaims: [
        { name: "features", function: "better_supabase.feature_claims" },
      ],
      budget: {
        claims: ["memberships"],
        bytes: 1024,
        truncatedClaim: "memberships_truncated",
      },
      markers: {
        hook: "-- permdock:hook v1",
        grants: "-- permdock:grants v1",
      },
      grantsCommand:
        "permdock supabase hook generate --grants-out supabase/migrations/<timestamp>_permdock_hook_grants.sql",
    });
  });

  it("reads the example's database-mode manifest and catalog", async () => {
    const provider = authorizationProvider({
      manifest: JSON.stringify(exampleManifest),
      catalog: exampleCatalog,
    });
    await expect(testAuthorizationProvider(provider)).resolves.toBeDefined();
    expect(provider.tenantScope).toBe("organization");
    expect(provider.scopes).toEqual([
      { name: "organization", idType: "uuid" },
      { name: "customer", idType: "uuid", parent: "organization" },
    ]);
    expect(provider.functions).toMatchObject({
      idsWithFor: "permdock.permitted_{scope}_ids_for({user}, {permission})",
      isPlatformFor: "permdock.permdock_has_for({user}, {permission})",
    });
    expect(provider.requires).toContainEqual({
      function: "permdock.permitted_customer_ids_for",
      args: "uuid, text",
      role: "postgres",
    });
    expect(provider.permissions).toContainEqual({
      key: "quotes.read",
      sqlComplete: true,
      scopes: ["customer", "organization"],
    });
  });

  it("marks a key with row conditions as not complete in SQL", () => {
    // SAFETY: the example catalog is a valid catalog document.
    const catalog = structuredClone(exampleCatalog) as {
      permissions: { key: string; rowConditions: boolean }[];
    };
    catalog.permissions[0]!.rowConditions = true;
    const provider = authorizationProvider({
      manifest: exampleManifest,
      catalog,
    });
    expect(provider.permissions?.[0]).toMatchObject({
      key: catalog.permissions[0]!.key,
      sqlComplete: false,
    });
  });

  it("takes a scope option and refuses one the manifest lacks", () => {
    expect(
      authorizationProvider({ manifest: exampleManifest, scope: "customer" })
        .tenantScope,
    ).toBe("customer");
    expect(() =>
      authorizationProvider({ manifest: exampleManifest, scope: "team" }),
    ).toThrow(/scope "team" is not in the manifest's rls.scopes/u);
  });

  it("refuses a manifest without a single root scope", () => {
    const manifest = withRls({
      scopes: [
        { name: "a", type: "uuid" },
        { name: "b", type: "uuid" },
      ],
    });
    expect(() => authorizationProvider({ manifest })).toThrow(
      /2 root scopes \(a, b\)/u,
    );
    expect(() =>
      authorizationProvider({ manifest: withRls({ scopes: [] }) }),
    ).toThrow(/0 root scopes \(none\)/u);
  });

  it("refuses an invalid manifest or catalog", () => {
    expect(() => authorizationProvider({ manifest: { version: 2 } })).toThrow(
      PermDockValidationError,
    );
    expect(() =>
      authorizationProvider({
        manifest: supabaseHookManifestFixture,
        catalog: { version: 2 },
      }),
    ).toThrow(PermDockValidationError);
  });

  it("reports missing helpers and user references, and skips other scopes", () => {
    const provider = authorizationProvider({
      manifest: withRls({
        schema: "AuthZ",
        helpers: [],
        memberships: [
          {
            table: "public.links",
            user: {
              column: "person_id",
              through: { table: "public.people", id: "id", column: "user_id" },
            },
            scope: { value: "tenant" },
            id: { column: "tenant_id" },
            role: { column: "role" },
            columns: ["person_id"],
          },
          {
            table: "public.multi",
            user: { column: "user_id" },
            scope: { value: ["tenant", "other"] },
            id: { column: "tenant_id" },
            role: { column: "role" },
            columns: ["user_id"],
          },
          {
            table: "public.other",
            user: { column: "user_id" },
            scope: { value: "other" },
            id: { column: "other_id" },
            role: { column: "role" },
            columns: ["user_id"],
          },
        ],
      }),
    });
    expect(provider.functions.idsWith).toBe(
      '"AuthZ".permitted_{scope}_ids({permission})',
    );
    expect(provider.functions.memberIds).toBeUndefined();
    expect(provider.memberships).toBeUndefined();
    expect(provider.problems).toEqual([
      expect.stringContaining("has no AuthZ.permitted_tenant_ids"),
      expect.stringContaining("has no AuthZ.permdock_has"),
      expect.stringContaining("reads its user id through public.people"),
    ]);
  });

  it("maps role sources, suspension rows and assignment helpers", () => {
    const helper = (name: string, args: string) => ({
      name,
      args,
      returns: "boolean",
      execute: ["authenticated"],
    });
    const provider = authorizationProvider({
      manifest: withRls({
        helpers: [
          ...supabaseHookManifestFixture.rls.helpers,
          helper("permdock_can_assign", "p_role text, p_scope_id text"),
          {
            ...helper(
              "permdock_can_assign_for",
              "p_user uuid, p_role text, p_scope_id text",
            ),
            execute: [],
          },
        ],
        memberships: [
          {
            table: "public.memberships",
            user: { column: "user_id" },
            scope: { value: "tenant" },
            id: { column: "tenant_id" },
            role: {
              column: "role_id",
              through: { table: "public.roles", id: "id", column: "key" },
            },
            columns: ["user_id", "role_id"],
          },
        ],
        suspension: {
          users: {
            table: "public.profiles",
            id: "id",
            disabledAt: "disabled_at",
          },
          scopes: {
            tenant: {
              table: "public.tenants",
              id: "id",
              status: "status",
              active: ["active"],
              keep: ["billing.read"],
            },
          },
        },
      }),
    });
    expect(provider.functions).toMatchObject({
      canAssign: "permdock.permdock_can_assign({role}, {tenant}::text)",
      canAssignFor:
        "permdock.permdock_can_assign_for({user}, {role}, {tenant}::text)",
    });
    expect(provider.requires).toContainEqual({
      function: "permdock.permdock_can_assign_for",
      args: "uuid, text, text",
      role: "postgres",
    });
    expect(provider.roleSources).toEqual([
      {
        table: "public.memberships",
        role: {
          column: "role_id",
          through: { table: "public.roles", id: "id", column: "key" },
        },
      },
    ]);
    expect(provider.suspension).toEqual({
      user: { table: "public.profiles", id: "id", disabledAt: "disabled_at" },
      tenant: {
        table: "public.tenants",
        id: "id",
        status: "status",
        active: ["active"],
      },
    });
  });
});
