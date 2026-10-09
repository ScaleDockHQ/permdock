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
const emptyCatalog = {
  $schema: "https://permdock.com/schemas/catalog-v1.json",
  version: 1,
  generatedAt: "2026-01-01T00:00:00Z",
  generator: "test",
  resources: {},
  permissions: [],
};

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
      catalog: emptyCatalog,
    });
    await expect(testAuthorizationProvider(provider)).resolves.toBeDefined();
    expect(provider).toMatchObject({
      apiVersion: 1,
      name: "PermDock",
      scopes: [{ name: "tenant", idType: "uuid" }],
      tenantScope: "tenant",
      functions: {
        idsWith: "permdock.permitted_{scope}_ids_by_permission({permission})",
        isPlatform: "permdock.permdock_has_permission({permission})",
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
    expect(provider.permissions).toEqual([]);
    expect(provider.problems).toBeUndefined();
    expect(Object.isFrozen(provider.functions)).toBe(true);
  });

  it("asks for the catalog so better-supabase can check module keys", () => {
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
    });
    expect(provider.problems).toEqual([
      expect.stringContaining("Pass `catalog`"),
    ]);
  });

  it("lists every helper with its argument types and calling role", () => {
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
    });
    expect(provider.requires).toEqual([
      {
        function: "permdock.permitted_tenant_ids_by_permission",
        args: "text",
        role: "authenticated",
      },
      {
        function: "permdock.permdock_has_permission",
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
        { name: "features", function: "public.feature_claims" },
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
      idsWithFor:
        "permdock.permitted_{scope}_ids_by_permission_for({user}, {permission})",
      isPlatformFor:
        "permdock.permdock_has_permission_for({user}, {permission})",
    });
    expect(provider.requires).toContainEqual({
      function: "permdock.permitted_customer_ids_by_permission_for",
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
      catalog: emptyCatalog,
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
      '"AuthZ".permitted_{scope}_ids_by_permission({permission})',
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

  it("checks custom roles through permdock_can_assign_any at the tenant scope", async () => {
    const helper = (
      name: string,
      args: string,
      execute = ["authenticated"],
    ) => ({
      name,
      args,
      returns: "boolean",
      execute,
    });
    const provider = authorizationProvider({
      catalog: emptyCatalog,
      manifest: withRls({
        customRoles: true,
        helpers: [
          ...supabaseHookManifestFixture.rls.helpers,
          helper("permdock_can_assign", "p_role text, p_scope_id text"),
          helper(
            "permdock_can_assign_for",
            "p_user uuid, p_role text, p_scope_id text",
            [],
          ),
          helper(
            "permdock_can_assign_any",
            "p_role text, p_tenant uuid, p_scope text, p_scope_id text",
          ),
          helper(
            "permdock_can_assign_any_for",
            "p_user uuid, p_role text, p_tenant uuid, p_scope text, p_scope_id text",
            [],
          ),
        ],
      }),
    });
    await expect(testAuthorizationProvider(provider)).resolves.toBeDefined();
    expect(provider.functions).toMatchObject({
      canAssign:
        "permdock.permdock_can_assign_any({role}, {tenant}, '{scope}', {tenant}::text)",
      canAssignFor:
        "permdock.permdock_can_assign_any_for({user}, {role}, {tenant}, '{scope}', {tenant}::text)",
    });
    expect(provider.requires).toEqual(
      expect.arrayContaining([
        {
          function: "permdock.permdock_can_assign_any",
          args: "text, uuid, text, text",
          role: "authenticated",
        },
        {
          function: "permdock.permdock_can_assign_any_for",
          args: "uuid, text, uuid, text, text",
          role: "postgres",
        },
      ]),
    );
    expect(
      provider.requires?.map((requirement) => requirement.function),
    ).not.toContain("permdock.permdock_can_assign");
    expect(provider.problems).toBeUndefined();
  });

  it("keeps the declared-role check below the root scope and says so", () => {
    const provider = authorizationProvider({
      catalog: emptyCatalog,
      scope: "project",
      manifest: withRls({
        customRoles: true,
        scopes: [
          { name: "tenant", type: "uuid" },
          { name: "project", type: "uuid", within: "tenant" },
        ],
        helpers: [
          ...supabaseHookManifestFixture.rls.helpers,
          {
            name: "permitted_project_ids",
            args: "p_grant text",
            returns: "setof uuid",
            execute: ["authenticated"],
          },
          {
            name: "permdock_can_assign",
            args: "p_role text, p_scope_id text",
            returns: "boolean",
            execute: ["authenticated"],
          },
          {
            name: "permdock_can_assign_any",
            args: "p_role text, p_tenant uuid, p_scope text, p_scope_id text",
            returns: "boolean",
            execute: ["authenticated"],
          },
        ],
      }),
    });
    expect(provider.functions.canAssign).toBe(
      "permdock.permdock_can_assign({role}, {tenant}::text)",
    );
    expect(provider.problems).toEqual([
      expect.stringContaining(
        'The tenant scope "project" is not a root scope, so canAssign checks declared roles only',
      ),
    ]);
  });

  it("reads a member's permission keys through permission_keys_for", async () => {
    const provider = authorizationProvider({
      manifest: withRls({
        helpers: [
          ...supabaseHookManifestFixture.rls.helpers,
          {
            name: "permitted_tenant_permission_keys_for",
            args: "p_user uuid, p_id uuid",
            returns: "setof text",
            execute: [],
          },
        ],
      }),
    });
    await expect(testAuthorizationProvider(provider)).resolves.toBeDefined();
    expect(provider.functions.permissionsFor).toBe(
      "array(select permdock.permitted_{scope}_permission_keys_for({user}, {tenant}))",
    );
    expect(provider.requires).toContainEqual({
      function: "permdock.permitted_tenant_permission_keys_for",
      args: "uuid, uuid",
      role: "postgres",
    });
  });

  it("lets an approver permission decide tool calls, never the requester", async () => {
    const approver = {
      key: "tools.approve",
      scope: "tools:approve",
      resource: "tools",
      action: "approve",
      meta: {},
      kind: "collection",
    } as const;
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
      approver,
    });
    await expect(testAuthorizationProvider(provider)).resolves.toBeDefined();
    expect(provider.functions.canApprove).toBe(
      "{tenant} in (select permdock.permitted_tenant_ids_by_permission('tools.approve'))",
    );
    expect(provider.approvals).toEqual({ distinctApprover: true });
    expect(provider.requires).toContainEqual({
      function: "permdock.permitted_tenant_ids_by_permission",
      args: "text",
      role: "postgres",
    });
    expect(
      authorizationProvider({
        manifest: exampleManifest,
        catalog: exampleCatalog,
        approver,
      }).problems,
    ).toContainEqual(
      expect.stringContaining("tools.approve is not in the catalog"),
    );
    expect(
      authorizationProvider({ manifest: supabaseHookManifestFixture }),
    ).not.toHaveProperty("approvals");
  });

  it("names Postgres id type aliases as better-supabase does and reports others", () => {
    const scoped = (type: string) =>
      authorizationProvider({
        manifest: withRls({
          scopes: [{ ...supabaseHookManifestFixture.rls.scopes[0]!, type }],
        }),
      });
    expect(scoped("int8").scopes).toEqual([
      { name: "tenant", idType: "bigint" },
    ]);
    expect(scoped("INT4").scopes).toEqual([
      { name: "tenant", idType: "integer" },
    ]);
    expect(scoped("citext").problems).toContainEqual(
      expect.stringContaining("ids of type citext"),
    );
  });
});
