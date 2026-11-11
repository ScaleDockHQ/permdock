import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DoctorFiles } from "../../src/cli/shared/doctor-types.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";

import {
  pd078,
  pd079,
  pd082,
  pd087,
  pd100,
} from "../../src/cli/doctor/better-supabase.ts";
import {
  betterSupabaseDefaults,
  betterSupabaseInstalled,
} from "../../src/cli/project/better-supabase.ts";
import { loadConfig } from "../../src/cli/project/config.ts";
import { supabaseHookSql } from "../../src/cli/supabase-hook/supabase-hook.ts";
import { tableMembershipSource } from "../../src/supabase/index.ts";
import { policyProject, removeProjects } from "./doctor-kit.ts";

const POLICY = "roles: [],";

function betterSupabaseConfig(blocks: object): string {
  return `export default ${JSON.stringify({ blocks })};\n`;
}

const CATALOG = JSON.stringify({
  $schema: "https://permdock.com/schemas/catalog-v2.json",
  version: 2,
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
    ["throw new Error('broken');", undefined, "tenant_id"],
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

  it("finds the config in a parent directory up to the workspace root", async () => {
    const root = policyProject(
      {},
      {
        "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
        "better-supabase.config.mjs":
          'export default { auth: { tenant: { claim: "org_id" } } };',
        "apps/web/permdock.config.mjs": `export default ${JSON.stringify(hookConfig())};`,
      },
    );
    const loaded = await loadConfig(path.join(root, "apps/web"));
    expect(loaded.supabase?.hook?.activeFrom).toBe("app_metadata.org_id");
    expect(loaded.supabase?.hook?.broadcast).toMatchObject({
      topic: "better_supabase:authz",
    });
  });

  it("prefers the nearest config and stops at the workspace root", async () => {
    const root = policyProject(
      {},
      {
        "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
        "better-supabase.config.mjs":
          'export default { claims: { tenant: "root_claim" } };',
        "apps/web/better-supabase.config.mjs":
          'export default { claims: { tenant: "app_claim" } };',
        "apps/web/permdock.config.mjs": `export default ${JSON.stringify(hookConfig())};`,
      },
    );
    const loaded = await loadConfig(path.join(root, "apps/web"));
    expect(loaded.supabase?.hook?.activeFrom).toBe("app_metadata.app_claim");
  });

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
                read: "audit.view",
                readAll: "audit.view",
                revert: "audit.revert",
              },
            },
          }),
        },
      );
      const findings = await pd079({ cwd, config });
      expect(findings).toStrictEqual([
        expect.objectContaining({ code: "PD079", severity: "error" }),
      ]);
      expect(findings[0]?.message).toBe(
        "audit.view (blocks.audit.permissions.read, blocks.audit.permissions.readAll) is not in permissions.catalog.json, so no role holds it and better-supabase's SQL check denies it",
      );
    });

    it("is an error when better-supabase/sql has no modulePermissionKeys", async () => {
      const cwd = policyProject(
        { policy: POLICY },
        {
          "permissions.catalog.json": CATALOG,
          "better-supabase.config.mjs": betterSupabaseConfig({
            audit: { permissions: { read: "audit.read" } },
          }),
          "node_modules/better-supabase/package.json": JSON.stringify({
            name: "better-supabase",
            version: "0.0.0",
            type: "module",
            exports: { "./sql": "./sql.mjs" },
          }),
          "node_modules/better-supabase/sql.mjs": "export const other = 1;\n",
        },
      );
      const findings = await pd079({ cwd, config });
      expect(findings).toStrictEqual([
        expect.objectContaining({ code: "PD079", severity: "error" }),
      ]);
      expect(findings[0]?.message).toContain("modulePermissionKeys");
    });

    it("treats a modulePermissionKeys that answers no list or throws another error as missing", async () => {
      for (const body of [
        "export const modulePermissionKeys = () => 'none';\n",
        "export const modulePermissionKeys = () => { throw new Error('unknown block'); };\n",
      ]) {
        const cwd = policyProject(
          { policy: POLICY },
          {
            "permissions.catalog.json": CATALOG,
            "better-supabase.config.mjs": betterSupabaseConfig({
              audit: { permissions: { read: "audit.read" } },
            }),
            "node_modules/better-supabase/package.json": JSON.stringify({
              name: "better-supabase",
              version: "0.0.0",
              type: "module",
              exports: { "./sql": "./sql.mjs" },
            }),
            "node_modules/better-supabase/sql.mjs": body,
          },
        );
        const findings = await pd079({ cwd, config });
        expect(findings[0]?.message).toContain("modulePermissionKeys");
      }
    });

    it("reports a former block action key apart from a missing modulePermissionKeys", async () => {
      const cwd = policyProject(
        { policy: POLICY },
        {
          "permissions.catalog.json": CATALOG,
          "better-supabase.config.mjs": betterSupabaseConfig({
            audit: { permissions: { view: "audit.read" } },
          }),
        },
      );
      const findings = await pd079({ cwd, config });
      expect(findings).toStrictEqual([
        expect.objectContaining({ code: "PD079", severity: "error" }),
      ]);
      expect(findings[0]?.message).toBe(
        "blocks.audit.permissions.view is a former block action key: better-supabase renamed it to read and refuses the config",
      );
      expect(findings[0]?.fix).toContain("better-supabase codemod naming");
    });

    it("passes when every block key is in the catalog", async () => {
      const cwd = policyProject(
        { policy: POLICY },
        {
          "permissions.catalog.json": CATALOG,
          "better-supabase.config.mjs": betterSupabaseConfig({
            audit: {
              permissions: {
                read: "audit.read",
                readAll: "audit.read",
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
        audit: { permissions: { read: "audit.view" } },
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

  describe("PD100", () => {
    const config: PermDockConfig = {
      permissions: "src/permissions.ts",
      policy: "src/policy.ts",
    };
    const sources = [
      {
        file: "src/permdock.ts",
        text: 'import { definePermDock } from "permdock/supabase";\n',
      },
      {
        file: "src/ok.ts",
        text: 'import { definePermDock } from "permdock/better-supabase";\nimport { createPermDock } from "permdock/supabase/middleware";\n',
      },
      {
        file: "src/types.ts",
        text: 'import type { definePermDock } from "permdock/supabase";\n',
      },
    ];

    it("flags a permdock/supabase factory next to a better-supabase config", async () => {
      const cwd = policyProject(
        { policy: POLICY },
        { "better-supabase.config.mjs": betterSupabaseConfig({}) },
      );
      const findings = await pd100({ cwd, config }, sources);
      expect(findings).toStrictEqual([
        expect.objectContaining({
          code: "PD100",
          severity: "error",
          target: "src/permdock.ts",
        }),
      ]);
    });

    it("stays quiet without a better-supabase config", async () => {
      const cwd = policyProject({ policy: POLICY }, {});
      expect(await pd100({ cwd, config }, sources)).toStrictEqual([]);
    });
  });

  describe("PD082", () => {
    it("warns when better-supabase's sessions block keeps a second version table", async () => {
      const cwd = policyProject(
        { policy: POLICY },
        {
          "better-supabase.config.mjs": betterSupabaseConfig({
            sessions: { authzVersions: true },
          }),
        },
      );
      expect(await pd082({ cwd, config: hookConfig() })).toStrictEqual([
        expect.objectContaining({ code: "PD082", severity: "warning" }),
      ]);
    });

    it("reports nothing without the sessions option or without PermDock's version", async () => {
      const off = policyProject(
        { policy: POLICY },
        {
          "better-supabase.config.mjs": betterSupabaseConfig({ sessions: {} }),
        },
      );
      expect(await pd082({ cwd: off, config: hookConfig() })).toStrictEqual([]);
      const on = policyProject(
        { policy: POLICY },
        {
          "better-supabase.config.mjs": betterSupabaseConfig({
            sessions: { options: { authzVersions: true } },
          }),
        },
      );
      const hook = hookConfig();
      const noVersion: PermDockConfig = {
        ...hook,
        supabase: {
          hook: {
            memberships: hook.supabase?.hook?.memberships ?? [],
            version: false,
          },
        },
      };
      expect(await pd082({ cwd: on, config: noVersion })).toStrictEqual([]);
    });
  });

  describe(betterSupabaseDefaults, () => {
    it("broadcasts on better-supabase's topic and leaves the receive policy to its sessions block", () => {
      const hook = hookConfig();
      expect(
        betterSupabaseDefaults(hook, { blocks: {} }).supabase?.hook?.broadcast,
      ).toStrictEqual({ topic: "better_supabase:authz", receivePolicy: true });
      expect(
        betterSupabaseDefaults(hook, {
          blocks: { sessions: { authzVersions: true } },
        }).supabase?.hook?.broadcast,
      ).toStrictEqual({ topic: "better_supabase:authz", receivePolicy: false });
    });
  });

  describe("detection through package.json", () => {
    function memoryFiles(
      entries: Readonly<Record<string, string>>,
    ): DoctorFiles {
      const paths = Object.keys(entries);
      const dirs = new Set<string>();
      for (const file of paths) {
        let dir = path.dirname(file);
        while (dir !== path.dirname(dir)) {
          dirs.add(dir);
          dir = path.dirname(dir);
        }
      }
      return {
        exists: (file) => file in entries || dirs.has(file),
        read: (file) => {
          const text = entries[file];
          if (text === undefined) throw new Error(`no file ${file}`);
          return text;
        },
        list: (dir) =>
          paths
            .filter((file) => path.dirname(file) === dir)
            .map((file) => path.basename(file))
            .concat(
              [...dirs]
                .filter((entry) => path.dirname(entry) === dir)
                .map((entry) => path.basename(entry)),
            ),
        isDirectory: (dir) => dirs.has(dir),
      };
    }

    const dependency = (name: string): string =>
      JSON.stringify({ devDependencies: { [name]: "^1.0.0" } });
    const workspace = (pkg: Record<string, string>): DoctorFiles =>
      memoryFiles({
        "/repo/pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
        "/repo/package.json": "{}",
        "/repo/apps/web/package.json": "{}",
        ...pkg,
      });

    it("finds a dependency in the nearest package.json or a workspace package", () => {
      const own = workspace({
        "/repo/apps/web/package.json": dependency("better-supabase"),
      });
      expect(
        betterSupabaseInstalled({ cwd: "/repo/apps/web", files: own }),
      ).toBe(true);
      const sibling = workspace({
        "/repo/packages/server/package.json": dependency("better-supabase"),
      });
      expect(
        betterSupabaseInstalled({ cwd: "/repo/apps/web", files: sibling }),
      ).toBe(true);
      const none = workspace({
        "/repo/packages/server/package.json": dependency("zod"),
      });
      expect(
        betterSupabaseInstalled({ cwd: "/repo/apps/web", files: none }),
      ).toBe(false);
    });

    it("warns when better-supabase is a dependency and its config is not found", async () => {
      const files = workspace({
        "/repo/packages/server/package.json": dependency("better-supabase"),
      });
      const found = await pd087({
        cwd: "/repo/apps/web",
        files,
        config: hookConfig(),
      });
      expect(found).toStrictEqual([
        expect.objectContaining({
          code: "PD087",
          fix: expect.stringContaining("betterSupabase.config"),
        }),
      ]);
    });

    it("warns when the hook pins another topic than better-supabase's", async () => {
      const files = workspace({
        "/repo/apps/web/package.json": dependency("better-supabase"),
      });
      const config: PermDockConfig = {
        supabase: {
          hook: { memberships: [], broadcast: { topic: "permdock:authz" } },
        },
      };
      const found = await pd087({ cwd: "/repo/apps/web", files, config });
      expect(found.map(({ message }) => message)).toStrictEqual([
        expect.stringContaining("better_supabase:authz"),
        expect.stringContaining("config file was not found"),
      ]);
    });

    it("reports nothing without better-supabase, without a hook version or with broadcast off", async () => {
      const files = workspace({});
      expect(
        await pd087({ cwd: "/repo/apps/web", files, config: hookConfig() }),
      ).toStrictEqual([]);
      const installed = workspace({
        "/repo/apps/web/package.json": dependency("better-supabase"),
      });
      const quiet: PermDockConfig = {
        supabase: { hook: { memberships: [], broadcast: false } },
      };
      expect(
        (
          await pd087({
            cwd: "/repo/apps/web",
            files: installed,
            config: quiet,
          })
        ).length,
      ).toBe(1);
    });

    it("reports nothing when the hook turns version reads off", async () => {
      const files = workspace({
        "/repo/apps/web/package.json": dependency("better-supabase"),
      });
      expect(
        await pd087({
          cwd: "/repo/apps/web",
          files,
          config: { supabase: { hook: { memberships: [], version: false } } },
        }),
      ).toStrictEqual([]);
    });

    it("applies better-supabase's topic when only the dependency is found", () => {
      expect(
        betterSupabaseDefaults(hookConfig(), undefined, true).supabase?.hook,
      ).toStrictEqual(
        expect.objectContaining({
          broadcast: { topic: "better_supabase:authz", receivePolicy: true },
        }),
      );
      expect(
        betterSupabaseDefaults(hookConfig(), undefined, true).supabase?.hook
          ?.activeFrom,
      ).toBeUndefined();
      expect(betterSupabaseDefaults(hookConfig(), undefined)).toStrictEqual(
        hookConfig(),
      );
    });

    it("reports nothing when the config is found and the topic is better-supabase's", async () => {
      const cwd = policyProject(
        { policy: POLICY },
        {
          "bs.config.mjs": betterSupabaseConfig({}),
          "package.json": dependency("better-supabase"),
        },
      );
      expect(
        await pd087({
          cwd,
          config: {
            ...hookConfig(),
            betterSupabase: { config: "bs.config.mjs" },
          },
        }),
      ).toStrictEqual([]);
    });

    it("reads the config from betterSupabase.config", async () => {
      const cwd = policyProject(
        { policy: POLICY },
        {
          "elsewhere/bs.config.mjs": betterSupabaseConfig({
            sessions: { authzVersions: true },
          }),
        },
      );
      const config = {
        ...hookConfig(),
        betterSupabase: { config: "elsewhere/bs.config.mjs" },
      };
      expect(await pd082({ cwd, config })).toStrictEqual([
        expect.objectContaining({ code: "PD082" }),
      ]);
    });
  });
});
