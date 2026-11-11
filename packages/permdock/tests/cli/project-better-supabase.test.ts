import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { DoctorFiles } from "../../src/cli/shared/doctor-types.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";

import {
  BETTER_SUPABASE_AUTHZ_TOPIC,
  betterSupabaseAuthzVersions,
  betterSupabaseConfig,
  betterSupabaseDefaults,
  betterSupabaseInstalled,
  betterSupabaseTenantClaim,
} from "../../src/cli/project/better-supabase.ts";
import { readConfig } from "../../src/cli/project/config.ts";

/** An in-memory tree: a path ending in `/` is a directory. */
function tree(entries: Readonly<Record<string, string>>): DoctorFiles {
  const paths = Object.keys(entries);
  const directories = new Set<string>();
  for (const path of paths) {
    for (let at = path; at.includes("/");) {
      at = at.slice(0, at.lastIndexOf("/"));
      directories.add(at === "" ? "/" : at);
    }
  }
  return {
    exists: (path) => path in entries || directories.has(path),
    read: (path) => {
      const text = entries[path];
      if (text === undefined) {
        throw new Error(`no such file: ${path}`);
      }
      return text;
    },
    list: (path) =>
      [
        ...new Set(
          paths
            .filter((entry) => entry.startsWith(`${path}/`))
            .map((entry) => entry.slice(path.length + 1).split("/")[0] ?? ""),
        ),
      ].filter((name) => name !== ""),
    isDirectory: (path) => directories.has(path),
  };
}

const dependsOn = (name: string): string =>
  JSON.stringify({ devDependencies: { [name]: "1.0.0" } });

describe(betterSupabaseInstalled, () => {
  it("finds the dependency in the project, a workspace package or the root", () => {
    const files = tree({
      "/repo/.git": "",
      "/repo/package.json": JSON.stringify({
        workspaces: { packages: ["tools/*", 4] },
      }),
      "/repo/apps/web/package.json": "{}",
      "/repo/tools/auth/package.json": dependsOn("better-supabase"),
    });
    expect(betterSupabaseInstalled({ cwd: "/repo/apps/web", files })).toBe(
      true,
    );
    expect(
      betterSupabaseInstalled({
        cwd: "/repo/apps/web",
        files: tree({
          "/repo/.git": "",
          "/repo/package.json": dependsOn("better-supabase"),
          "/repo/apps/web/package.json": "{}",
        }),
      }),
    ).toBe(true);
  });

  it("reads the packages list of pnpm-workspace.yaml and skips exclusions", () => {
    const files = tree({
      "/repo/pnpm-workspace.yaml": [
        "packages:",
        '  - "libs/*"',
        "  - '!libs/skip'",
        "  - single",
        "  # a comment",
        "catalog:",
        "  - ignored",
      ].join("\n"),
      "/repo/libs/a/package.json": "{}",
      "/repo/libs/node_modules/x/package.json": dependsOn("better-supabase"),
      "/repo/single/package.json": dependsOn("better-supabase"),
      "/repo/app/package.json": "{}",
    });
    expect(betterSupabaseInstalled({ cwd: "/repo/app", files })).toBe(true);
    expect(
      betterSupabaseInstalled({
        cwd: "/repo/app",
        files: tree({
          "/repo/pnpm-workspace.yaml": "packages:\n  - libs/*\n",
          "/repo/libs/node_modules/x/package.json":
            dependsOn("better-supabase"),
          "/repo/libs/a/package.json": "{}",
          "/repo/app/package.json": "not json",
        }),
      }),
    ).toBe(false);
  });

  it("reads a workspaces array", () => {
    const files = tree({
      "/repo/.git": "",
      "/repo/package.json": JSON.stringify({ workspaces: ["tools/*"] }),
      "/repo/apps/web/package.json": "{}",
      "/repo/tools/auth/package.json": dependsOn("better-supabase"),
    });
    expect(betterSupabaseInstalled({ cwd: "/repo/apps/web", files })).toBe(
      true,
    );
  });

  it("treats an unreadable manifest as no dependency", () => {
    const files = tree({ "/repo/.git": "", "/repo/package.json": "{" });
    expect(betterSupabaseInstalled({ cwd: "/repo", files })).toBe(false);
  });
});

describe(betterSupabaseConfig, () => {
  it("finds nothing when no config file exists or the named one is missing", async () => {
    const files = tree({ "/repo/.git": "" });
    expect(await betterSupabaseConfig({ cwd: "/repo", files })).toBeUndefined();
    expect(
      await betterSupabaseConfig({
        cwd: "/repo",
        files,
        path: "missing.config.ts",
      }),
    ).toBeUndefined();
  });

  it("answers undefined when the file does not load", async () => {
    const files = tree({
      "/repo/.git": "",
      "/repo/better-supabase.config.ts": "export default {};",
    });
    expect(await betterSupabaseConfig({ cwd: "/repo", files })).toBeUndefined();
  });
});

describe(betterSupabaseTenantClaim, () => {
  const config: PermDockConfig = { rls: { tenantClaim: "org" } };

  it("reads the grouped claim, the flat claim, rls.tenantClaim, then tenant_id", () => {
    expect(
      betterSupabaseTenantClaim(config, {
        auth: { tenant: { claim: "grouped" } },
      }),
    ).toBe("grouped");
    expect(
      betterSupabaseTenantClaim(config, { claims: { tenant: "flat" } }),
    ).toBe("flat");
    expect(betterSupabaseTenantClaim(config, { claims: { tenant: "" } })).toBe(
      "org",
    );
    expect(betterSupabaseTenantClaim({}, { auth: "x" })).toBe("tenant_id");
  });
});

describe(betterSupabaseAuthzVersions, () => {
  it("is true for a sessions block that writes its own versions", () => {
    expect(betterSupabaseAuthzVersions({})).toBe(false);
    expect(betterSupabaseAuthzVersions({ blocks: { sessions: true } })).toBe(
      false,
    );
    expect(
      betterSupabaseAuthzVersions({
        blocks: { sessions: { authzVersions: true } },
      }),
    ).toBe(true);
    expect(
      betterSupabaseAuthzVersions({
        blocks: { sessions: { options: { authzVersions: true } } },
      }),
    ).toBe(true);
    expect(
      betterSupabaseAuthzVersions({ blocks: { sessions: { options: 1 } } }),
    ).toBe(false);
  });
});

describe(betterSupabaseDefaults, () => {
  const hooked: PermDockConfig = { supabase: { hook: { memberships: [] } } };

  it("leaves a config without a hook, or without better-supabase, as it is", () => {
    expect(betterSupabaseDefaults({}, {})).toStrictEqual({});
    expect(betterSupabaseDefaults(hooked, undefined)).toBe(hooked);
  });

  it("broadcasts on the better-supabase topic with only the dependency", () => {
    expect(
      betterSupabaseDefaults(hooked, undefined, true).supabase?.hook,
    ).toStrictEqual({
      memberships: [],
      broadcast: { topic: BETTER_SUPABASE_AUTHZ_TOPIC, receivePolicy: true },
    });
  });

  it("takes the active tenant and the receive policy from the config", () => {
    const hook = betterSupabaseDefaults(hooked, {
      claims: { tenant: "org_id" },
      blocks: { sessions: { authzVersions: true } },
    }).supabase?.hook;
    expect(hook?.activeFrom).toBe("app_metadata.org_id");
    expect(hook?.broadcast).toStrictEqual({
      topic: BETTER_SUPABASE_AUTHZ_TOPIC,
      receivePolicy: false,
    });
  });

  it("keeps a hook's own broadcast, activeFrom and a disabled broadcast", () => {
    const own: PermDockConfig = {
      supabase: {
        hook: {
          memberships: [],
          activeFrom: "user_metadata.x",
          broadcast: { topic: "t", receivePolicy: true },
        },
      },
    };
    const hook = betterSupabaseDefaults(own, {}).supabase?.hook;
    expect(hook?.activeFrom).toBe("user_metadata.x");
    expect(hook?.broadcast).toStrictEqual({ topic: "t", receivePolicy: true });
    expect(
      betterSupabaseDefaults(
        { supabase: { hook: { memberships: [], broadcast: false } } },
        {},
      ).supabase?.hook?.broadcast,
    ).toBe(false);
  });
});

describe("readConfig with a better-supabase config", () => {
  it("writes the same hook defaults whether the better-supabase config loads or not", async () => {
    const project = (betterSupabase: string): string => {
      const cwd = mkdtempSync(join(tmpdir(), "permdock-bs-load-"));
      writeFileSync(
        join(cwd, "permdock.config.mjs"),
        "export default { supabase: { hook: {} } };\n",
      );
      writeFileSync(join(cwd, "better-supabase.config.mjs"), betterSupabase);
      return cwd;
    };
    const failing = project(
      'throw new Error("no permdock.manifest.json yet");\n',
    );
    const loading = project("export default {};\n");
    const named = project("export default {};\n");
    try {
      const failed = await readConfig(failing);
      const loaded = await readConfig(loading);
      expect(failed.config.supabase?.hook).toStrictEqual(
        loaded.config.supabase?.hook,
      );
      expect(failed.config.supabase?.hook?.activeFrom).toBe(
        "app_metadata.tenant_id",
      );
      expect(failed.warnings).toStrictEqual([
        "[better_supabase_config] better-supabase.config.mjs did not load (no permdock.manifest.json yet); the hook reads app_metadata.tenant_id unless supabase.hook.activeFrom is set",
      ]);
      expect(loaded.warnings).toStrictEqual([]);
      writeFileSync(
        join(named, "permdock.config.mjs"),
        'export default { rls: { tenantClaim: "org_id" }, supabase: { hook: {} } };\n',
      );
      writeFileSync(
        join(named, "better-supabase.config.mjs"),
        'throw "no catalog";\n',
      );
      const thrown = await readConfig(named);
      expect(thrown.warnings.at(-1)).toContain(
        "did not load (no catalog); the hook reads app_metadata.org_id",
      );
    } finally {
      rmSync(failing, { recursive: true, force: true });
      rmSync(loading, { recursive: true, force: true });
      rmSync(named, { recursive: true, force: true });
    }
  });
});
