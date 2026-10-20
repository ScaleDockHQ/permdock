import { describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";
import type { CustomRole, Principal } from "../../src/index.ts";
import type { PowerSyncWatchable } from "../../src/react-native/powersync.ts";

import { localRows } from "../../src/cli/powersync/rows.ts";
import { localSnapshotManifest } from "../../src/core/local-manifest.ts";
import { memoryCustomRoleSource } from "../../src/core/memory-sources.ts";
import { parseLocalSnapshotManifest } from "../../src/core/parse-local-manifest.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  getPermDock,
  principal,
  resource,
  role,
  sqlFunction,
} from "../../src/index.ts";
import { powerSyncSource } from "../../src/react-native/powersync.ts";
import { memorySnapshotStorage } from "../../src/react-native/storage.ts";
import { nativeStore } from "../../src/react-native/store.ts";
import { junctionMembershipSource } from "../../src/supabase/index.ts";

const Row = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;

const permissions = definePermissions({
  job: resource(Row, {
    id: "id",
    actions: ["read", "update"],
    relations: { tenant: { field: "tenant_id", memberOf: "tenant" } },
    levels: {
      own: { owner_id: principal.id },
      team: sqlFunction("permdock_in_team", {
        args: [{ field: "team_id" }],
        twin: { team_id: { in: { ref: "principal.claims.team_ids" } } },
      }),
      all: {},
    },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "tenant_id" } },
  // SAFETY: the test passes a principal as the user.
  subject: (user: unknown) => user as Principal,
  roles: [
    role(
      "owner",
      [allow(permissions.job.read), allow(permissions.job.update)],
      {
        on: "tenant",
        assignable: true,
      },
    ),
  ],
});

const config: PermDockConfig = {
  policy: "p.ts",
  rls: {
    authorize: "database",
    customRoles: true,
    tables: { job: "jobs" },
    roles: { table: "platform_roles" },
    membershipSources: [
      junctionMembershipSource({
        table: "tenant_users",
        scope: "tenant",
        id: "tenant_id",
        roles: "tier_role",
      }),
      junctionMembershipSource({
        table: "user_roles",
        scope: "tenant",
        id: "tenant_id",
        roles: { through: "roles", on: { role_id: "id" }, column: "key" },
      }),
    ],
  },
};

const customRoles: readonly CustomRole[] = [
  {
    name: "tech",
    tenant: "t1",
    scope: "tenant",
    grants: [
      { permission: "job.read", effect: "allow", level: "own" },
      { permission: "job.update", effect: "allow", level: "own" },
    ],
    includes: [],
  },
  {
    name: "lead",
    tenant: "t1",
    scope: "tenant",
    grants: [{ permission: "job.update", effect: "allow", level: "team" }],
    includes: [],
  },
];

const tables: Record<string, readonly Record<string, unknown>[]> = {
  tenant_users: [
    { user_id: "alice", tenant_id: "t1", tier_role: "owner" },
    { user_id: "bob", tenant_id: "t1", tier_role: null },
    { user_id: "carol", tenant_id: "t1", tier_role: null },
  ],
  user_roles: [
    { user_id: "bob", tenant_id: "t1", role_id: "r1" },
    { user_id: "carol", tenant_id: "t1", role_id: "r2" },
  ],
  roles: [
    { id: "r1", key: "tech" },
    { id: "r2", key: "lead" },
  ],
  platform_roles: [],
  custom_role_permissions: customRoles.flatMap((custom) =>
    (custom.grants ?? []).map((grant) => ({
      tenant_id: "t1",
      scope: "tenant",
      scope_id: null,
      role: custom.name,
      permission: grant.permission,
      effect: grant.effect,
      level: grant.level,
    })),
  ),
  custom_role_includes: [],
};

function wholeTables(): PowerSyncWatchable {
  return {
    getAll: async (sql) => {
      const table = /FROM "(\w+)"/u.exec(sql)?.[1] ?? "";
      return [...(tables[table] ?? [])];
    },
    watch: (_sql, _parameters, handler) => {
      handler.onResult({});
    },
  };
}

const members = [
  { id: "alice", roles: ["owner"] },
  { id: "bob", roles: ["tech"] },
  { id: "carol", roles: ["lead"], claims: { team_ids: ["A"] } },
] as const;

const jobs = [
  { id: "j1", tenant_id: "t1", owner_id: "bob", team_id: "A" },
  { id: "j2", tenant_id: "t1", owner_id: "dan", team_id: "B" },
  { id: "j3", tenant_id: "t2", owner_id: "bob", team_id: "A" },
];

describe("powerSyncSource from the manifest rows", () => {
  const { rows, warnings } = localRows(policy, config);
  const manifest = { ...localSnapshotManifest(policy), rows };

  it("names the synced tables the device reads", () => {
    expect(warnings).toEqual([]);
    expect(rows.memberships.map((source) => source.table)).toEqual([
      "tenant_users",
      "user_roles",
    ]);
    expect(rows.customRoles).toEqual({
      permissions: "custom_role_permissions",
      includes: "custom_role_includes",
    });
  });

  it.each(members)("answers like the server for $id", async (member) => {
    const claims = "claims" in member ? { claims: member.claims } : undefined;
    const source = powerSyncSource(wholeTables(), {
      manifest,
      user: member.id,
      tenant: "t1",
      ...(claims === undefined ? {} : { attributes: claims }),
    });
    const store = nativeStore({
      storage: memorySnapshotStorage(),
      subjectId: member.id,
      snapshot: await source.get(),
    });
    const server = await getPermDock(
      policy,
      {
        id: member.id,
        tenant: "t1",
        memberships: [{ scope: "tenant", id: "t1", roles: [...member.roles] }],
        ...claims,
      },
      { customRoles: memoryCustomRoleSource(customRoles) },
    );
    const { job } = permissions;
    for (const row of jobs) {
      for (const permission of [job.read, job.update]) {
        expect(store.get().can(permission, row)).toBe(
          server.can(permission, row),
        );
      }
    }
  });

  it("grants each member what the policy and its custom role allow", async () => {
    const answers = await Promise.all(
      members.map(async (member) => {
        const source = powerSyncSource(wholeTables(), {
          manifest,
          user: member.id,
          tenant: "t1",
          ...("claims" in member
            ? { attributes: { claims: member.claims } }
            : {}),
        });
        const store = nativeStore({
          storage: memorySnapshotStorage(),
          subjectId: member.id,
          snapshot: await source.get(),
        });
        return jobs.map((row) => store.get().can(permissions.job.update, row));
      }),
    );
    expect(answers).toEqual([
      [true, true, false],
      [true, false, false],
      [true, false, false],
    ]);
  });

  it("drops a membership row with an expiry", async () => {
    const expiring = {
      ...rows,
      memberships: rows.memberships.map((source) =>
        source.table === "tenant_users"
          ? { ...source, expiresAt: "expires_at" }
          : source,
      ),
    };
    const saved = tables["tenant_users"];
    tables["tenant_users"] = [
      {
        user_id: "alice",
        tenant_id: "t1",
        tier_role: "owner",
        expires_at: "2026-11-01",
      },
    ];
    const source = powerSyncSource(wholeTables(), {
      manifest: { ...manifest, rows: expiring },
      user: "alice",
    });
    const snapshot = await source.get();
    tables["tenant_users"] = saved ?? [];
    const store = nativeStore({
      storage: memorySnapshotStorage(),
      subjectId: "alice",
      snapshot,
    });
    expect(store.get().can(permissions.job.update, jobs[0])).toBe(false);
  });

  it("parses the rows section after a JSON round trip and rejects a bad one", () => {
    const json: Record<string, unknown> = JSON.parse(JSON.stringify(manifest));
    expect(parseLocalSnapshotManifest(json)).toBe(true);
    expect(parseLocalSnapshotManifest({ ...json, rows: {} })).toBe(false);
    expect(
      parseLocalSnapshotManifest({
        ...json,
        rows: {
          memberships: [{ ...rows.memberships[0], roles: [{ column: 1 }] }],
        },
      }),
    ).toBe(false);
    expect(
      parseLocalSnapshotManifest({
        ...json,
        rows: { ...rows, customRoles: { permissions: "p" } },
      }),
    ).toBe(false);
  });

  it("throws for a manifest with no rows section", () => {
    expect(() =>
      powerSyncSource(wholeTables(), {
        manifest: localSnapshotManifest(policy),
        user: "alice",
      }),
    ).toThrow(TypeError);
  });

  it("warns when two synced tables share a device name", () => {
    const shared: PermDockConfig = {
      ...config,
      rls: {
        authorize: "database",
        customRoles: true,
        membershipSources: config.rls?.membershipSources ?? [],
      },
    };
    expect(localRows(policy, shared).warnings).toEqual([
      "permdock.user_roles and public.user_roles share the device table user_roles: rename one so the device reads each apart",
    ]);
  });
});
