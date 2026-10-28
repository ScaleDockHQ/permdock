import { afterEach, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { pd078, pd079 } from "../../src/cli/doctor/better-supabase.ts";
import { loadConfig } from "../../src/cli/project/config.ts";
import { supabaseHookSql } from "../../src/cli/supabase-hook/supabase-hook.ts";
import { tableMembershipSource } from "../../src/supabase/index.ts";
import { policyProject, removeProjects } from "./doctor-kit.ts";

const POLICY = "roles: [],";

function betterSupabaseConfig(blocks: object): string {
  return `export default ${JSON.stringify({ blocks })};\n`;
}

const CATALOG = JSON.stringify({
  $schema: "https://permdock.com/schemas/catalog-v1.json",
  version: 1,
  generatedAt: "2026-10-25T00:00:00Z",
  generator: "test",
  resources: { post: { id: "id", schema: null } },
  permissions: ["audit.read", "audit.revert"].map((key) => ({
    key,
    resource: "audit",
    action: key.split(".")[1],
    scope: key.replace(".", ":"),
    meta: {},
    arity: "collection",
    usages: [],
    rowConditions: false,
  })),
});

function hookConfig(activeFrom?: string): PermDockConfig {
  return {
    permissions: "src/permissions.ts",
    policy: "src/policy.ts",
    supabase: {
      hook: {
        memberships: [],
        ...(activeFrom === undefined ? {} : { activeFrom }),
      },
    },
  };
}

describe("doctor better-supabase", () => {
  afterEach(removeProjects);

  it.each([
    [undefined, undefined, "active_tenant"],
    ["export default {};", undefined, "tenant_id"],
    ["export default {};", "workspace_id", "workspace_id"],
    [
      'export default { auth: { tenant: { claim: "org_id" } } };',
      "workspace_id",
      "org_id",
    ],
    ['export default { claims: { tenant: "team_id" } };', undefined, "team_id"],
    [
      'export default { auth: { tenant: { claim: "" } } };',
      undefined,
      "tenant_id",
    ],
    ["throw new Error('broken');", undefined, "active_tenant"],
    ["export default 1;", undefined, "active_tenant"],
  ])(
    "shares detected defaults with SQL and manifest: %s / %s",
    async (source, tenantClaim, expected) => {
      const config = {
        ...hookConfig(),
        ...(tenantClaim === undefined ? {} : { rls: { tenantClaim } }),
      };
      const cwd = policyProject(
        {},
        {
          "permdock.config.mjs": `export default ${JSON.stringify(config)};`,
          ...(source === undefined
            ? {}
            : { "better-supabase.config.mjs": source }),
        },
      );
      const loaded = await loadConfig(cwd);
      const generated = supabaseHookSql([], {
        ...loaded,
        supabase: {
          hook: {
            ...loaded.supabase?.hook,
            memberships: [tableMembershipSource({ table: "memberships" })],
          },
        },
      });
      expect(generated.manifest.hook.activeFrom).toStrictEqual({
        appMetadata: expected,
      });
      expect(generated.sql).toContain(
        `claims -> 'app_metadata' ->> '${expected}'`,
      );
    },
  );

  it("preserves an explicit source in detected projects", async () => {
    const cwd = policyProject(
      {},
      {
        "permdock.config.mjs": `export default ${JSON.stringify(hookConfig("app_metadata.custom"))};`,
        "better-supabase.config.mjs": "export default {};",
      },
    );
    expect((await loadConfig(cwd)).supabase?.hook?.activeFrom).toBe(
      "app_metadata.custom",
    );
  });

  describe("PD078", () => {
    it("warns when switch_organization writes a claim the hook does not read", async () => {
      const cwd = policyProject(
        { policy: POLICY },
        {
          "better-supabase.config.mjs": betterSupabaseConfig({
            permissions: { activeTenant: "claim" },
          }),
        },
      );
      const findings = await pd078({
        cwd,
        config: hookConfig("app_metadata.active_tenant"),
      });
      expect(findings).toStrictEqual([
        expect.objectContaining({ code: "PD078", severity: "warning" }),
      ]);
      expect(findings[0]?.message).toContain(
        "reads the active tenant from app_metadata.active_tenant",
      );
      expect(findings[0]?.message).toContain(
        'supabase.hook.activeFrom: "app_metadata.tenant_id"',
      );
    });

    it("passes when the hook reads the claim better-supabase writes", async () => {
      const cwd = policyProject(
        { policy: POLICY },
        {
          "better-supabase.config.mjs": betterSupabaseConfig({
            permissions: { activeTenant: "claim" },
          }),
        },
      );
      expect(
        await pd078({ cwd, config: hookConfig("app_metadata.tenant_id") }),
      ).toStrictEqual([]);
    });

    it("names the claim better-supabase's auth.tenant.claim writes", async () => {
      const cwd = policyProject(
        { policy: POLICY },
        {
          "better-supabase.config.mjs": `export default ${JSON.stringify({
            auth: { tenant: { claim: "org_id" } },
            blocks: { permissions: { activeTenant: "claim" } },
          })};\n`,
        },
      );
      expect(
        await pd078({ cwd, config: hookConfig("app_metadata.org_id") }),
      ).toStrictEqual([]);
      const [finding] = await pd078({
        cwd,
        config: hookConfig("app_metadata.tenant_id"),
      });
      expect(finding?.message).toContain(
        'supabase.hook.activeFrom: "app_metadata.org_id"',
      );
    });

    it("compares a profile column with the hook's table source", async () => {
      const cwd = policyProject(
        { policy: POLICY },
        {
          "better-supabase.config.mjs": betterSupabaseConfig({
            permissions: {
              activeTenant: { profileColumn: "profiles.active_org" },
            },
          }),
        },
      );
      expect(
        await pd078({ cwd, config: hookConfig("public.profiles.active_org") }),
      ).toStrictEqual([]);
      const [finding] = await pd078({ cwd, config: hookConfig() });
      expect(finding?.message).toContain(
        'Set supabase.hook.activeFrom: { table: "public.profiles", column: "active_org", id: "id" }',
      );
    });

    it("stays quiet for the resolver and without a better-supabase config", async () => {
      const resolver = policyProject(
        { policy: POLICY },
        {
          "better-supabase.config.mjs": betterSupabaseConfig({
            permissions: { activeTenant: "resolver" },
          }),
        },
      );
      expect(
        await pd078({ cwd: resolver, config: hookConfig() }),
      ).toStrictEqual([]);
      const none = policyProject({ policy: POLICY });
      expect(await pd078({ cwd: none, config: hookConfig() })).toStrictEqual(
        [],
      );
    });

    it("stays quiet without a hook, a readable config or a valid activeFrom", async () => {
      const claim = policyProject(
        { policy: POLICY },
        {
          "better-supabase.config.mjs": betterSupabaseConfig({
            permissions: { activeTenant: "claim" },
          }),
        },
      );
      expect(
        await pd078({
          cwd: claim,
          config: {
            permissions: "src/permissions.ts",
            policy: "src/policy.ts",
          },
        }),
      ).toStrictEqual([]);
      expect(
        await pd078({ cwd: claim, config: hookConfig("not a source") }),
      ).toStrictEqual([]);
      const throwing = policyProject(
        { policy: POLICY },
        { "better-supabase.config.mjs": 'throw new Error("broken");\n' },
      );
      expect(
        await pd078({ cwd: throwing, config: hookConfig() }),
      ).toStrictEqual([]);
      const bare = policyProject(
        { policy: POLICY },
        { "better-supabase.config.mjs": "export default 1;\n" },
      );
      expect(await pd078({ cwd: bare, config: hookConfig() })).toStrictEqual(
        [],
      );
      const noBlocks = policyProject(
        { policy: POLICY },
        { "better-supabase.config.mjs": "export default {};\n" },
      );
      expect(
        await pd078({ cwd: noBlocks, config: hookConfig() }),
      ).toStrictEqual([]);
    });

    it("uses the detected claim default even when the policy does not load", async () => {
      const cwd = policyProject(
        {},
        {
          "better-supabase.config.mjs": betterSupabaseConfig({
            permissions: { activeTenant: "claim" },
          }),
        },
      );
      expect(await pd078({ cwd, config: hookConfig() })).toStrictEqual([]);
    });

    it("reads the key of a profile column", async () => {
      const cwd = policyProject(
        { policy: POLICY },
        {
          "better-supabase.config.mjs": betterSupabaseConfig({
            permissions: {
              activeTenant: {
                profileColumn: "profiles.active_org",
                key: "user_id",
              },
            },
          }),
        },
      );
      const [finding] = await pd078({ cwd, config: hookConfig() });
      expect(finding?.message).toContain('id: "user_id"');
    });
  });

  describe("PD079", () => {
    const config: PermDockConfig = {
      permissions: "src/permissions.ts",
      policy: "src/policy.ts",
    };

    it("lists block keys the catalog does not declare", async () => {
      const cwd = policyProject(
        { policy: POLICY },
        {
          "permissions.catalog.json": CATALOG,
          "better-supabase.config.mjs": betterSupabaseConfig({
            audit: {
              permissions: {
                view: "audit.view",
                viewAll: "audit.view",
                revert: "audit.revert",
              },
            },
          }),
        },
      );
      const findings = await pd079({ cwd, config });
      expect(findings).toStrictEqual([
        expect.objectContaining({ code: "PD079", severity: "warning" }),
      ]);
      expect(findings[0]?.message).toBe(
        "audit.view (blocks.audit.permissions.view, blocks.audit.permissions.viewAll) is not in permissions.catalog.json, so no role holds it and better-supabase's SQL check denies it",
      );
    });

    it("passes when every block key is in the catalog", async () => {
      const cwd = policyProject(
        { policy: POLICY },
        {
          "permissions.catalog.json": CATALOG,
          "better-supabase.config.mjs": betterSupabaseConfig({
            audit: {
              permissions: {
                view: "audit.read",
                viewAll: "audit.read",
                revert: "audit.revert",
              },
            },
          }),
        },
      );
      expect(await pd079({ cwd, config })).toStrictEqual([]);
    });

    it("stays quiet without blocks or a readable catalog", async () => {
      const blocks = betterSupabaseConfig({
        audit: { permissions: { view: "audit.view" } },
      });
      const noBlocks = policyProject(
        { policy: POLICY },
        {
          "permissions.catalog.json": CATALOG,
          "better-supabase.config.mjs": "export default {};\n",
        },
      );
      expect(await pd079({ cwd: noBlocks, config })).toStrictEqual([]);
      const noCatalog = policyProject(
        { policy: POLICY },
        { "better-supabase.config.mjs": blocks },
      );
      expect(await pd079({ cwd: noCatalog, config })).toStrictEqual([]);
      const badCatalog = policyProject(
        { policy: POLICY },
        {
          "permissions.catalog.json": "{",
          "better-supabase.config.mjs": blocks,
        },
      );
      expect(await pd079({ cwd: badCatalog, config })).toStrictEqual([]);
    });
  });
});
