import { afterEach, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { pd078, pd079 } from "../../src/cli/doctor/better-supabase.ts";
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
      const findings = await pd078({ cwd, config: hookConfig() });
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
  });
});
