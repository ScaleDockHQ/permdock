import { moduleIdType } from "better-supabase/sql";
import { testAuthorizationProvider } from "better-supabase/testing";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { SupabaseHookManifest } from "../../src/supabase/manifest.ts";

import { authorizationProvider } from "../../src/better-supabase/index.ts";
import { anyOf, holder, manager, user } from "../../src/core/approvers.ts";
import { PermDockValidationError } from "../../src/core/validation-error.ts";
import { supabaseHookManifestFixture } from "../../src/testing/supabase-fixtures.ts";
import { defined } from "../support/defined.ts";

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

describe(authorizationProvider, () => {
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
    expect(provider.permissions).toStrictEqual([]);
    expect(provider.problems).toBeUndefined();
    expect(Object.isFrozen(provider.functions)).toBe(true);
  });

  it("asks for the catalog so better-supabase can check module keys", () => {
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
    });
    expect(provider.problems).toStrictEqual([
      expect.stringContaining("Pass `catalog`"),
    ]);
  });

  it("lists every helper with its argument types and calling role", () => {
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
    });
    expect(provider.requires).toStrictEqual([
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

  it("reads a manifest without a token hook", () => {
    const {
      hook: _hook,
      budget: _budget,
      claims: _claims,
      authzVersion: _authzVersion,
      memberships: _memberships,
      ...hookless
    } = supabaseHookManifestFixture;
    const provider = authorizationProvider({ manifest: hookless });
    expect(provider.tokenHook).toBeUndefined();
    expect(provider.scopes).toStrictEqual(
      authorizationProvider({ manifest: supabaseHookManifestFixture }).scopes,
    );
  });

  it("describes the token hook from the manifest's claims", () => {
    const { tokenHook } = authorizationProvider({
      manifest: supabaseHookManifestFixture,
    });
    expect(tokenHook).toStrictEqual({
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
      truncatedClaim: "memberships_truncated",
      registeredClaims: [
        { name: "features", function: "public.feature_claims" },
      ],
      budget: {
        claims: ["memberships"],
        bytes: 1024,
        truncatedClaim: "memberships_truncated",
      },
      markers: { hook: "-- permdock:hook v1", grants: "-- permdock:grants v1" },
      grantsCommand:
        "permdock supabase hook generate && supabase db schema declarative sync -f permdock_hook",
    });
  });

  it("names no truncated marker when the hook writes none", () => {
    const { tokenHook } = authorizationProvider({
      manifest: {
        ...supabaseHookManifestFixture,
        claims: supabaseHookManifestFixture.claims.filter(
          (claim) => claim.name !== "memberships_truncated",
        ),
      },
    });
    expect(tokenHook).not.toHaveProperty("truncatedClaim");
    expect(tokenHook?.budget).not.toHaveProperty("truncatedClaim");
  });

  it("names the grants command of the manifest's schema workflow", () => {
    const command = (schemas: "pg-delta" | "migra" | "migrations") =>
      authorizationProvider({
        manifest: {
          ...supabaseHookManifestFixture,
          hook: { ...supabaseHookManifestFixture.hook, schemas },
        },
      }).tokenHook?.grantsCommand;
    expect(command("pg-delta")).toBe(
      "permdock supabase hook generate && supabase db schema declarative sync -f permdock_hook",
    );
    expect(command("migra")).toBe(
      "permdock supabase hook generate --grants-out supabase/migrations/<timestamp>_permdock_hook_grants.sql",
    );
    expect(command("migrations")).toBe(
      "permdock supabase hook generate --out supabase/migrations/<timestamp>_permdock_hook.sql",
    );
  });

  it("reads the example's database-mode manifest and catalog", async () => {
    const provider = authorizationProvider({
      manifest: JSON.stringify(exampleManifest),
      catalog: exampleCatalog,
    });
    await expect(testAuthorizationProvider(provider)).resolves.toBeDefined();
    expect(provider.tenantScope).toBe("organization");
    expect(provider.scopes).toStrictEqual([
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

  it("fills holdersOf and actorMayWrite from the example's helpers", () => {
    const provider = authorizationProvider({
      manifest: exampleManifest,
      catalog: exampleCatalog,
    });
    expect(provider.functions).toMatchObject({
      holdersOf:
        "permdock.permitted_organization_users({permission}, {tenant})",
      actorMayWrite: "permdock.permdock_actor_may_write()",
    });
    expect(provider.requires).toContainEqual({
      function: "permdock.permitted_organization_users",
      args: "text, uuid",
      role: "postgres",
    });
    expect(provider.requires).toContainEqual({
      function: "permdock.permdock_actor_may_write",
      role: "authenticated",
    });
    expect(provider.requires).not.toContainEqual(
      expect.objectContaining({
        function: "permdock.permitted_customer_users",
      }),
    );
  });

  it("leaves holdersOf and actorMayWrite unset without their helpers", () => {
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
      catalog: emptyCatalog,
    });
    expect(provider.functions).not.toHaveProperty("holdersOf");
    expect(provider.functions).not.toHaveProperty("actorMayWrite");
    expect(provider.functions).not.toHaveProperty("teamIdsOf");
    expect(provider).not.toHaveProperty("problems");
  });

  describe("activeTenant", () => {
    const hooked = (
      activeFrom: NonNullable<SupabaseHookManifest["hook"]["activeFrom"]>,
    ): SupabaseHookManifest => ({
      ...supabaseHookManifestFixture,
      hook: { ...supabaseHookManifestFixture.hook, activeFrom },
    });

    it("reports a hook that reads another place than better-supabase writes", () => {
      const provider = authorizationProvider({
        manifest: hooked({ appMetadata: "active_tenant" }),
        catalog: emptyCatalog,
        activeTenant: "claim",
      });
      expect(provider.problems).toStrictEqual([
        `blocks.permissions.activeTenant is "claim", so better-supabase's switch_organization writes app_metadata.${supabaseHookManifestFixture.tenantClaim}, but PermDock's token hook reads the active tenant from app_metadata.active_tenant. Set supabase.hook.activeFrom: "app_metadata.${supabaseHookManifestFixture.tenantClaim}" and run permdock supabase hook generate.`,
      ]);
    });

    it("reports nothing when they agree, for the resolver, or without activeFrom", () => {
      const claim = supabaseHookManifestFixture.tenantClaim;
      for (const provider of [
        authorizationProvider({
          manifest: hooked({ appMetadata: claim }),
          catalog: emptyCatalog,
          activeTenant: "claim",
        }),
        authorizationProvider({
          manifest: hooked({ appMetadata: "active_tenant" }),
          catalog: emptyCatalog,
          activeTenant: "resolver",
        }),
        authorizationProvider({
          manifest: hooked({
            table: "public.profiles",
            column: "active_org",
            id: "id",
          }),
          catalog: emptyCatalog,
          activeTenant: { profileColumn: "profiles.active_org" },
        }),
        authorizationProvider({
          manifest: {
            ...supabaseHookManifestFixture,
            hook: {
              schema: supabaseHookManifestFixture.hook.schema,
              function: supabaseHookManifestFixture.hook.function,
              out: supabaseHookManifestFixture.hook.out,
            },
          },
          catalog: emptyCatalog,
          activeTenant: "claim",
        }),
      ]) {
        expect(provider.problems).toBeUndefined();
      }
    });

    it("names the hook's source as tokenHook.activeOrganizationFrom for doctor BS409", () => {
      const claim = supabaseHookManifestFixture.tenantClaim;
      const from = (
        activeFrom: NonNullable<SupabaseHookManifest["hook"]["activeFrom"]>,
        activeTenant?: "resolver",
      ) =>
        authorizationProvider({
          manifest: hooked(activeFrom),
          catalog: emptyCatalog,
          ...(activeTenant === undefined ? {} : { activeTenant }),
        }).tokenHook?.activeOrganizationFrom;
      expect(from({ appMetadata: claim })).toBe("claim");
      expect(
        from({ table: "profiles", column: "active_org", id: "id" }),
      ).toStrictEqual({ profileColumn: "public.profiles.active_org" });
      expect(
        from({ table: "app.users", column: "org", id: "user_id" }),
      ).toStrictEqual({ profileColumn: "app.users.org", key: "user_id" });
      expect(from({ appMetadata: "active_tenant" })).toBeUndefined();
      expect(from({ appMetadata: claim }, "resolver")).toBeUndefined();
    });
  });

  describe("teamIdsOf", () => {
    const teamManifest = (name: string, listed: boolean) =>
      withRls({
        scopes: [
          { name: "tenant", type: "uuid" },
          { name, type: "uuid", within: "tenant" },
        ],
        helpers: [
          ...supabaseHookManifestFixture.rls.helpers,
          ...(listed
            ? [
                {
                  name: `member_${name}_ids_of`,
                  args: "p_user uuid",
                  returns: "setof uuid",
                  execute: ["authenticated"],
                },
              ]
            : []),
        ],
      });

    it.each(["team", "teams"])(
      "calls member_%s_ids_of({user}) for a team scope",
      (name) => {
        const provider = authorizationProvider({
          manifest: teamManifest(name, true),
          catalog: emptyCatalog,
        });
        expect(provider.functions.teamIdsOf).toBe(
          `permdock.member_${name}_ids_of({user})`,
        );
        expect(provider.requires).toContainEqual({
          function: `permdock.member_${name}_ids_of`,
          args: "uuid",
          role: "authenticated",
        });
      },
    );

    it("calls the hook's member_team_ids_of without a team scope", () => {
      const provider = authorizationProvider({
        manifest: teamManifest("squad", false),
        catalog: emptyCatalog,
      });
      expect(provider.functions).not.toHaveProperty("teamIdsOf");
      const hooked = authorizationProvider({
        manifest: withRls({
          helpers: [
            ...supabaseHookManifestFixture.rls.helpers,
            {
              name: "member_team_ids_of",
              args: "p_user uuid",
              returns: "setof uuid",
              execute: ["authenticated"],
            },
          ],
        }),
        catalog: emptyCatalog,
      });
      expect(hooked.functions.teamIdsOf).toBe(
        "permdock.member_team_ids_of({user})",
      );
    });

    it("stays unset without the helper or a team scope", () => {
      expect(
        authorizationProvider({
          manifest: teamManifest("team", false),
          catalog: emptyCatalog,
        }).functions,
      ).not.toHaveProperty("teamIdsOf");
      expect(
        authorizationProvider({
          manifest: teamManifest("squad", true),
          catalog: emptyCatalog,
        }).functions,
      ).not.toHaveProperty("teamIdsOf");
    });

    it("passes better-supabase's conformance kit", async () => {
      await expect(
        testAuthorizationProvider(
          authorizationProvider({
            manifest: teamManifest("team", true),
            catalog: emptyCatalog,
          }),
        ),
      ).resolves.toBeDefined();
    });
  });

  it("marks a key with row conditions as not complete in SQL", () => {
    // SAFETY: the example catalog is a valid catalog document.
    const catalog = structuredClone(exampleCatalog) as {
      permissions: { key: string; rowConditions: boolean }[];
    };
    defined(catalog.permissions[0]).rowConditions = true;
    const provider = authorizationProvider({
      manifest: exampleManifest,
      catalog,
    });
    expect(provider.permissions?.[0]).toMatchObject({
      key: defined(catalog.permissions[0]).key,
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
    expect(provider.problems).toStrictEqual([
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
    expect(provider.roleSources).toStrictEqual([
      {
        table: "public.memberships",
        role: {
          column: "role_id",
          through: { table: "public.roles", id: "id", column: "key" },
        },
      },
    ]);
    expect(provider.suspension).toStrictEqual({
      user: { table: "public.profiles", id: "id", disabledAt: "disabled_at" },
      tenant: {
        table: "public.tenants",
        id: "id",
        status: "status",
        active: ["active"],
      },
    });
  });

  it("names a role set read over a composite reference as rolesTable", () => {
    const membership = {
      table: "better_supabase.memberships",
      user: { column: "user_id" },
      scope: { value: "tenant" },
      id: { column: "organization_id" },
      columns: ["user_id", "organization_id"],
    } as const;
    const provider = authorizationProvider({
      manifest: withRls({
        memberships: [
          {
            ...membership,
            role: {
              column: "organization_id",
              through: {
                table: "better_supabase.membership_roles",
                id: "organization_id",
                column: "role",
                on: { organization_id: "organization_id", user_id: "user_id" },
              },
            },
          },
          {
            ...membership,
            table: "public.memberships",
            role: { column: "role" },
          },
        ],
      }),
    });
    expect(provider.memberships).toStrictEqual([
      {
        table: "better_supabase.memberships",
        userColumn: "user_id",
        scope: { value: "tenant" },
        idColumn: "organization_id",
        rolesTable: "better_supabase.membership_roles",
      },
      {
        table: "public.memberships",
        userColumn: "user_id",
        scope: { value: "tenant" },
        idColumn: "organization_id",
      },
    ]);
    expect(provider).not.toHaveProperty("roleSources");
  });

  it("checks custom roles through permdock_can_assign_any at the tenant scope", async () => {
    const helper = (
      name: string,
      args: string,
      execute = ["authenticated"],
    ) => ({ name, args, returns: "boolean", execute });
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
    expect(provider.requires).toStrictEqual(
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
    expect(provider.problems).toStrictEqual([
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

  it("turns an approver permission into the ai-tool isApprover branch", () => {
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
    expect(provider.functions).not.toHaveProperty("canApprove");
    expect(provider).not.toHaveProperty("approvals");
    expect(provider.problems).toContainEqual(
      expect.stringContaining("permdock.permdock_is_approver"),
    );
  });

  describe("approvers", () => {
    const approve = {
      key: "invoice.approve",
      scope: "invoice:approve",
      resource: "invoice",
      action: "approve",
      meta: {},
      kind: "collection",
    } as const;
    const tools = { ...approve, key: "tools.approve" } as const;
    const catalog = {
      ...emptyCatalog,
      permissions: [
        {
          key: "invoice.approve",
          scope: "tenant",
          resource: "invoice",
          action: "approve",
          arity: "collection",
          meta: {},
          usages: [],
          rowConditions: false,
        },
      ],
    };
    const manifest = withRls({
      helpers: [
        ...supabaseHookManifestFixture.rls.helpers,
        {
          name: "permdock_is_approver",
          args: "p_approvers jsonb, p_tenant text",
          returns: "boolean",
          execute: ["authenticated"],
        },
      ],
    });

    it("fills isApprover with one branch per kind and drops canApprove", () => {
      const provider = authorizationProvider({
        manifest,
        catalog,
        approver: tools,
        approvers: {
          "invoice.send": [user("u1"), holder(approve)],
          "support-session": anyOf(user("u1"), holder(approve)),
        },
      });
      expect(provider.functions.isApprover).toBe(
        "case {kind} " +
          `when 'ai-tool' then permdock.permdock_is_approver('{"kind":"permission","permission":"tools.approve"}'::jsonb, ({tenant})::text) ` +
          `when 'invoice.send' then permdock.permdock_is_approver('[{"kind":"user","id":"u1"},{"kind":"permission","permission":"invoice.approve"}]'::jsonb, ({tenant})::text) ` +
          `when 'support-session' then permdock.permdock_is_approver('{"kind":"any-of","of":[{"kind":"user","id":"u1"},{"kind":"permission","permission":"invoice.approve"}]}'::jsonb, ({tenant})::text) ` +
          "else false end",
      );
      expect(provider.functions).not.toHaveProperty("canApprove");
      expect(provider).not.toHaveProperty("approvals");
      expect(provider.requires).toContainEqual({
        function: "permdock.permdock_is_approver",
        args: "jsonb, text",
        role: "postgres",
      });
      expect(provider.problems).toStrictEqual([
        expect.stringContaining("tools.approve is not in the catalog"),
      ]);
    });

    it("keeps an ai-tool entry of its own over approver", () => {
      const provider = authorizationProvider({
        manifest,
        catalog,
        approver: tools,
        approvers: { "ai-tool": user("u1") },
      });
      expect(provider.functions.isApprover).toBe(
        `case {kind} when 'ai-tool' then permdock.permdock_is_approver('{"kind":"user","id":"u1"}'::jsonb, ({tenant})::text) else false end`,
      );
      expect(provider.problems).toBeUndefined();
    });

    it("quotes a kind and approver ids that hold quotes", () => {
      const provider = authorizationProvider({
        manifest,
        catalog,
        approvers: { "o'k": user("it's") },
      });
      expect(provider.functions.isApprover).toContain(
        `when 'o''k' then permdock.permdock_is_approver('{"kind":"user","id":"it''s"}'::jsonb`,
      );
    });

    it("passes {requester} and the kind's resource when the helper takes covers", () => {
      const provider = authorizationProvider({
        manifest: withRls({
          helpers: [
            ...supabaseHookManifestFixture.rls.helpers,
            {
              name: "permdock_is_approver",
              args: "p_approvers jsonb, p_tenant text, p_requester text, p_resource text",
              returns: "boolean",
              execute: ["authenticated"],
            },
          ],
        }),
        catalog,
        approvers: {
          "invoice.send": holder(approve),
          "support-session": user("u1"),
        },
      });
      expect(provider.functions.isApprover).toBe(
        "case {kind} " +
          `when 'invoice.send' then permdock.permdock_is_approver('{"kind":"permission","permission":"invoice.approve"}'::jsonb, ({tenant})::text, ({requester})::text, 'invoice') ` +
          `when 'support-session' then permdock.permdock_is_approver('{"kind":"user","id":"u1"}'::jsonb, ({tenant})::text, ({requester})::text, 'support-session') ` +
          "else false end",
      );
      expect(provider.requires).toContainEqual({
        function: "permdock.permdock_is_approver",
        args: "jsonb, text, text, text",
        role: "postgres",
      });
    });

    it("passes manager() approvers with rls.approvals.managers and reports them without", () => {
      const fourArgs = {
        name: "permdock_is_approver",
        args: "p_approvers jsonb, p_tenant text, p_requester text, p_resource text",
        returns: "boolean",
        execute: ["authenticated"],
      };
      const withManagers = authorizationProvider({
        manifest: withRls({
          helpers: [
            ...supabaseHookManifestFixture.rls.helpers,
            fourArgs,
            {
              name: "permdock_manages",
              args: "p_requester text, p_levels integer",
              returns: "boolean",
              execute: [],
            },
          ],
        }),
        catalog,
        approvers: { "expense.submit": manager({ levels: 2 }) },
      });
      expect(withManagers.functions.isApprover).toBe(
        "case {kind} " +
          `when 'expense.submit' then permdock.permdock_is_approver('{"kind":"manager","levels":2}'::jsonb, ({tenant})::text, ({requester})::text, 'expense') ` +
          "else false end",
      );
      expect(withManagers.problems).toBeUndefined();
      const without = authorizationProvider({
        manifest: withRls({
          helpers: [...supabaseHookManifestFixture.rls.helpers, fourArgs],
        }),
        catalog,
        approvers: { "expense.submit": manager() },
      });
      expect(without.problems).toStrictEqual([
        expect.stringContaining(
          "checks only with rls.approvals.managers, so it matches nobody",
        ),
      ]);
    });

    it("passes better-supabase's {approvers} with requestApprovers, for every kind", () => {
      const covers = withRls({
        helpers: [
          ...supabaseHookManifestFixture.rls.helpers,
          {
            name: "permdock_is_approver",
            args: "p_approvers jsonb, p_tenant text, p_requester text, p_resource text",
            returns: "boolean",
            execute: ["authenticated"],
          },
        ],
      });
      const provider = authorizationProvider({
        manifest: covers,
        catalog,
        approvers: { "invoice.send": holder(approve) },
        requestApprovers: true,
      });
      expect(provider.functions.isApprover).toBe(
        "case {kind} " +
          `when 'invoice.send' then permdock.permdock_is_approver('{"kind":"permission","permission":"invoice.approve"}'::jsonb, ({tenant})::text, ({requester})::text, 'invoice', ({approvers})::jsonb) ` +
          `else permdock.permdock_is_approver(null::jsonb, ({tenant})::text, ({requester})::text, split_part({kind}, '.', 1), ({approvers})::jsonb) end`,
      );
      expect(provider.requires).toContainEqual({
        function: "permdock.permdock_is_approver",
        args: "jsonb, text, text, text, jsonb",
        role: "postgres",
      });
      expect(
        authorizationProvider({
          manifest: covers,
          catalog,
          requestApprovers: true,
        }).functions.isApprover,
      ).toBe(
        `permdock.permdock_is_approver(null::jsonb, ({tenant})::text, ({requester})::text, split_part({kind}, '.', 1), ({approvers})::jsonb)`,
      );
      const twoArgs = authorizationProvider({
        manifest,
        catalog,
        requestApprovers: true,
      });
      expect(twoArgs.functions).not.toHaveProperty("isApprover");
      expect(twoArgs.problems).toContainEqual(
        expect.stringContaining("requestApprovers needs the five-argument"),
      );
    });

    it("reports approvers SQL cannot check, empty kinds and no kinds", () => {
      const provider = authorizationProvider({
        manifest,
        catalog,
        approvers: {
          "": user("u1"),
          "invoice.send": { kind: "role", role: "admin", scope: "tenant" },
        },
      });
      expect(provider.problems).toStrictEqual([
        expect.stringContaining("empty kind"),
        expect.stringContaining("a role approver"),
      ]);
      expect(provider.functions.isApprover).toContain("'invoice.send'");
      const none = authorizationProvider({ manifest, catalog, approvers: {} });
      expect(none.functions).not.toHaveProperty("isApprover");
      expect(none.problems).toStrictEqual([expect.stringContaining("no kind")]);
    });

    it("sets no approver template without permdock_is_approver", () => {
      const provider = authorizationProvider({
        manifest: supabaseHookManifestFixture,
        catalog: { ...catalog, permissions: [] },
        approver: tools,
        approvers: { "invoice.send": user("u1") },
      });
      expect(provider.functions).not.toHaveProperty("isApprover");
      expect(provider.functions).not.toHaveProperty("canApprove");
      expect(provider.problems).toContainEqual(
        expect.stringContaining("permdock.permdock_is_approver"),
      );
    });

    it("says holder() approvers match nobody below the root scope", () => {
      const nested = withRls({
        scopes: [
          { name: "tenant", type: "uuid" },
          { name: "team", type: "uuid", within: "tenant" },
        ],
        helpers: manifest.rls.helpers,
      });
      const provider = authorizationProvider({
        manifest: nested,
        catalog,
        scope: "team",
        approvers: { "invoice.send": holder(approve) },
      });
      expect(provider.problems).toContainEqual(
        expect.stringContaining('"team" is not a root scope'),
      );
    });
  });

  it("names Postgres id type aliases as better-supabase does and reports others", () => {
    const scoped = (type: string) =>
      authorizationProvider({
        manifest: withRls({
          scopes: [
            { ...defined(supabaseHookManifestFixture.rls.scopes[0]), type },
          ],
        }),
      });
    for (const type of [
      "uuid",
      "text",
      "varchar",
      "Character  Varying",
      "bigint",
      "int8",
      "integer",
      "int",
      "INT4",
    ]) {
      expect(scoped(type).scopes).toStrictEqual([
        { name: "tenant", idType: moduleIdType(type) },
      ]);
    }
    expect(moduleIdType("citext")).toBeUndefined();
    expect(scoped("citext").problems).toContainEqual(
      expect.stringContaining("ids of type citext"),
    );
  });

  describe("permitted", () => {
    it("checks a scope instance against its ids and other resources at the tenant", () => {
      // SAFETY: the example catalog is a valid catalog document.
      const catalog = structuredClone(exampleCatalog) as {
        permissions: { key: string; rowConditions: boolean }[];
      };
      for (const permission of catalog.permissions) {
        permission.rowConditions = true;
      }
      defined(catalog.permissions[0]).rowConditions = false;
      const ids = (scope: string) =>
        `select ids::text from permdock.permitted_${scope}_ids_by_permission({permission}) as ids`;
      expect(
        authorizationProvider({ manifest: exampleManifest, catalog }).functions
          .permitted,
      ).toBe(
        `case when {resource} = 'organization' then {id} in (${ids("organization")}) ` +
          `when {resource} = 'customer' then {id} in (${ids("customer")}) ` +
          `else {permission} in ('${defined(catalog.permissions[0]).key}') and {tenant} in (${ids("organization")}) end`,
      );
    });

    it("refuses other resources when no key is complete in SQL, and checks the tenant without a catalog", () => {
      expect(
        authorizationProvider({
          manifest: supabaseHookManifestFixture,
          catalog: emptyCatalog,
        }).functions.permitted,
      ).toContain("else false and {tenant} in (");
      expect(
        authorizationProvider({ manifest: supabaseHookManifestFixture })
          .functions.permitted,
      ).toContain(
        "else {tenant} in (select ids::text from permdock.permitted_tenant_ids_by_permission({permission}) as ids) end",
      );
    });
  });

  it("lists the catalog's operations as tools, keeping a dotted name as written", async () => {
    const leaf = (key: string) => {
      const [resource = "", action = ""] = key.split(".");
      return {
        key,
        scope: `${resource}:${action}`,
        resource,
        action,
        arity: "collection",
        meta: {},
        usages: [],
        rowConditions: false,
      };
    };
    const catalog = {
      ...emptyCatalog,
      permissions: ["invoice.send", "http.call", "invoice.list"].map(leaf),
      operations: [
        {
          name: "send_invoice",
          permission: "invoice.send",
          meta: { risk: "critical", effects: ["send", "spend", "write"] },
        },
        {
          name: "workflow.node.http",
          permission: "http.call",
          meta: { title: "HTTP request" },
        },
        { name: "list_invoices", permission: "invoice.list", meta: {} },
      ],
    };
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
      catalog,
    });
    await expect(testAuthorizationProvider(provider)).resolves.toBeDefined();
    const sent = {
      permission: "invoice.send",
      meta: { risk: "high", effects: ["external", "write"] },
    };
    expect(provider.operations).toStrictEqual({
      "ai.tool.send_invoice": sent,
      "mcp.tool.send_invoice": sent,
      "workflow.node.http": {
        permission: "http.call",
        meta: { title: "HTTP request" },
      },
      "ai.tool.list_invoices": { permission: "invoice.list" },
      "mcp.tool.list_invoices": { permission: "invoice.list" },
    });
    expect(
      authorizationProvider({ manifest: supabaseHookManifestFixture }),
    ).not.toHaveProperty("operations");
    expect(provider.delegation).toStrictEqual({
      scopes: {
        "invoice:send": ["invoice.send"],
        "http:call": ["http.call"],
        "invoice:list": ["invoice.list"],
      },
    });
  });

  it("merges the catalog's oauthScopes into delegation.scopes", async () => {
    const leaf = (key: string) => {
      const [resource = "", action = ""] = key.split(".");
      return {
        key,
        scope: `${resource}:${action}`,
        resource,
        action,
        arity: "collection",
        meta: {},
        usages: [],
        rowConditions: false,
      };
    };
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
      catalog: {
        ...emptyCatalog,
        permissions: ["task.read", "task.update", "task.delete"].map(leaf),
        oauthScopes: [
          { scope: "mcp:read", permissions: ["task.read"] },
          { scope: "mcp:write", permissions: ["task.update", "task.read"] },
          { scope: "task:read", permissions: ["task.update"] },
        ],
      },
    });
    await expect(testAuthorizationProvider(provider)).resolves.toBeDefined();
    expect(provider.delegation).toStrictEqual({
      scopes: {
        "mcp:read": ["task.read"],
        "mcp:write": ["task.read", "task.update"],
        "task:delete": ["task.delete"],
        "task:read": ["task.read", "task.update"],
        "task:update": ["task.update"],
      },
    });
    expect(() =>
      authorizationProvider({
        manifest: supabaseHookManifestFixture,
        catalog: {
          ...emptyCatalog,
          permissions: [leaf("task.read")],
          oauthScopes: [{ scope: "mcp:read", permissions: ["task.gone"] }],
        },
      }),
    ).toThrow(/'task.gone' is not a declared permission key/u);
  });

  it("maps a renamed permission's former scope in delegation.scopes", () => {
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
      catalog: {
        ...emptyCatalog,
        permissions: [
          {
            key: "doc.read",
            scope: "doc:read",
            resource: "doc",
            action: "read",
            arity: "collection",
            meta: {},
            usages: [],
            rowConditions: false,
            renamedFrom: ["doc.view"],
          },
        ],
      },
    });
    expect(provider.delegation).toStrictEqual({
      scopes: { "doc:read": ["doc.read"], "doc:view": ["doc.read"] },
    });
  });

  describe("rowHelpers", () => {
    const withRows: SupabaseHookManifest = {
      ...supabaseHookManifestFixture,
      names: {
        schema: "permdock",
        gucPrefix: "permdock",
        claims: { tenant: "tenant_id", role: "role" },
        scopes: {},
        resources: { fileNode: { rows: "permitted_file_node_rows" } },
      },
    };

    it("fills rowsWith from the row helpers only when asked", () => {
      expect(
        authorizationProvider({ manifest: withRows, catalog: emptyCatalog })
          .functions,
      ).not.toHaveProperty("rowsWith");

      const provider = authorizationProvider({
        manifest: withRows,
        catalog: emptyCatalog,
        rowHelpers: true,
      });

      expect(provider.functions).toMatchObject({
        rowsWith: "permdock.permitted_{resource}_rows({permission}, {ids})",
        rowsWithFor:
          "permdock.permitted_{resource}_rows_for({user}, {permission})",
      });
      expect(provider.requires).toContainEqual({
        function: "permdock.permitted_file_node_rows",
        args: "text, text[]",
        role: "authenticated",
      });
      expect(provider.requires).toContainEqual({
        function: "permdock.permitted_file_node_rows_for",
        args: "uuid, text, jsonb",
        role: "postgres",
      });
    });

    it("names a missing row helper", () => {
      const none = authorizationProvider({
        manifest: supabaseHookManifestFixture,
        catalog: emptyCatalog,
        rowHelpers: true,
      });

      expect(none.functions).not.toHaveProperty("rowsWith");
      expect(none.problems).toContainEqual(
        expect.stringContaining("names no permitted_<resource>_rows helper"),
      );
    });
  });
});
