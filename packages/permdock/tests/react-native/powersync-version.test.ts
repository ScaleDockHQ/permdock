import { describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";
import type { PowerSyncWatchable } from "../../src/react-native/powersync.ts";

import { localRows } from "../../src/cli/powersync/rows.ts";
import { POSTGRES, powersyncPlan } from "../../src/cli/powersync/streams.ts";
import { localSnapshotManifest } from "../../src/core/local-manifest.ts";
import { parseLocalSnapshotManifest } from "../../src/core/parse-local-manifest.ts";
import { buildLocalSnapshot } from "../../src/react-native/local.ts";
import { powerSyncSource } from "../../src/react-native/powersync.ts";
import { policy } from "../fixtures/quick-start.ts";

const config: PermDockConfig = {
  policy: "p.ts",
  rls: { authorize: "database" },
  supabase: { hook: { memberships: [] } },
};

function db(
  tables: Record<string, readonly Record<string, unknown>[]>,
): PowerSyncWatchable {
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

describe("synced authz_ver", () => {
  it("streams the user's version row when the token hook stamps authz_ver", () => {
    const stream = powersyncPlan(policy, config).subject.find(
      (entry) => entry.table === "permdock_authz_version",
    );
    expect(stream).toStrictEqual({
      name: "permdock_authz_version",
      table: "permdock_authz_version",
      user: "user_id",
      queries: [
        'SELECT * FROM "permdock"."permdock_authz_version" AS permdock_authz_version WHERE permdock_authz_version.user_id = auth.user_id()',
      ],
    });
    expect(
      powersyncPlan(policy, config, POSTGRES).subject.find(
        (entry) => entry.table === "permdock_authz_version",
      )?.queries,
    ).toStrictEqual([
      'SELECT * FROM "permdock"."permdock_authz_version" AS permdock_authz_version WHERE permdock_authz_version.user_id::text = $1::text',
    ]);
  });

  it("streams no version row without the hook or with hook.version off", () => {
    for (const target of [
      { ...config, supabase: {} },
      { ...config, supabase: { hook: { memberships: [], version: false } } },
    ]) {
      expect(
        powersyncPlan(policy, target).subject.map((entry) => entry.table),
      ).not.toContain("permdock_authz_version");
      expect(localRows(policy, target, new Map()).version).toBeUndefined();
    }
  });

  it("names the version table in the manifest rows under hook.schema", () => {
    const target = {
      ...config,
      supabase: { hook: { memberships: [], schema: "authz" } },
    };
    const rows = localRows(
      policy,
      target,
      powersyncPlan(policy, target).devices,
    );
    expect(rows.version).toStrictEqual({
      table: "permdock_authz_version",
      user: "user_id",
      version: "version",
    });
    expect(
      parseLocalSnapshotManifest({ ...localSnapshotManifest(policy), rows }),
    ).toBe(true);
    expect(
      parseLocalSnapshotManifest({
        ...localSnapshotManifest(policy),
        rows: { ...rows, version: { table: "v", user: "user_id" } },
      }),
    ).toBe(false);
  });

  it("sets snapshot.authzVersion from the highest synced version", async () => {
    const rows = localRows(
      policy,
      config,
      powersyncPlan(policy, config).devices,
    );
    const manifest = { ...localSnapshotManifest(policy), rows };
    const source = powerSyncSource(
      db({
        permdock_authz_version: [
          { user_id: "u1", version: "7" },
          { user_id: "u1", version: 9 },
          { user_id: "u2", version: 40 },
          { user_id: "u1", version: "not a number" },
        ],
      }),
      { manifest, user: "u1" },
    );
    const snapshot = await source.get();
    expect(
      typeof snapshot === "string" ? snapshot : snapshot.authzVersion,
    ).toBe(9);
    const empty = powerSyncSource(db({}), { manifest, user: "u1" });
    expect(await empty.get()).not.toHaveProperty("authzVersion");
  });

  it("answers the user's synced version from authzVersion", async () => {
    const rows = localRows(
      policy,
      config,
      powersyncPlan(policy, config).devices,
    );
    const manifest = { ...localSnapshotManifest(policy), rows };
    const queries: (readonly [string, unknown[] | undefined])[] = [];
    const versions = [
      { user_id: "u1", version: 9 },
      { user_id: "u2", version: 40 },
    ];
    const watchable: PowerSyncWatchable = {
      getAll: async (sql, parameters) => {
        queries.push([sql, parameters]);
        return versions.filter((row) => row.user_id === parameters?.[0]);
      },
      watch: () => undefined,
    };
    const source = powerSyncSource(watchable, { manifest, user: "u1" });
    await expect(source.authzVersion()).resolves.toBe(9);
    expect(queries).toStrictEqual([
      [
        'SELECT "version" AS version FROM "permdock_authz_version" WHERE "user_id" = ?',
        ["u1"],
      ],
    ]);
    versions.length = 0;
    await expect(source.authzVersion()).resolves.toBeUndefined();
    const custom = powerSyncSource(watchable, {
      manifest,
      queries: {},
      read: () => ({ principal: null }),
    });
    await expect(custom.authzVersion()).resolves.toBeUndefined();
    const unversioned = powerSyncSource(watchable, {
      manifest: { ...manifest, rows: { memberships: rows.memberships } },
      user: "u1",
    });
    await expect(unversioned.authzVersion()).resolves.toBeUndefined();
  });

  it("ignores an authzVersion that is not a non-negative safe integer", () => {
    const manifest = localSnapshotManifest(policy);
    for (const authzVersion of [-1, 1.5, Number.NaN]) {
      expect(
        buildLocalSnapshot(manifest, { principal: null, authzVersion }),
      ).not.toHaveProperty("authzVersion");
    }
    expect(
      buildLocalSnapshot(manifest, { principal: null, authzVersion: 0 })
        .authzVersion,
    ).toBe(0);
  });
});
