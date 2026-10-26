import { describe, expect, it, vi } from "vitest";

import type { PowerSyncWatchable } from "../../src/react-native/powersync.ts";

import { localSnapshotManifest } from "../../src/core/local-manifest.ts";
import { powerSyncSourceCache } from "../../src/react-native/powersync.ts";
import { policy } from "../fixtures/quick-start.ts";

const db: PowerSyncWatchable = {
  getAll: async () => [],
  watch: () => undefined,
};

const withRows = () => ({
  ...localSnapshotManifest(policy),
  rows: { memberships: [] },
});

describe(powerSyncSourceCache, () => {
  it("answers one source per manifest and rows options content", () => {
    const cache = powerSyncSourceCache(db);
    const manifest = withRows();
    const first = cache.source({
      manifest,
      user: "u1",
      tenant: "o1",
      attributes: { claims: { team_ids: ["t1"] } },
    });
    expect(
      cache.source({
        manifest,
        user: "u1",
        tenant: "o1",
        attributes: { claims: { team_ids: ["t1"] } },
      }),
    ).toBe(first);
    expect(cache.source({ manifest, user: "u1", tenant: "o2" })).not.toBe(
      first,
    );
    expect(cache.source({ manifest, user: "u2", tenant: "o1" })).not.toBe(
      first,
    );
    expect(
      cache.source({ manifest: withRows(), user: "u1", tenant: "o1" }),
    ).not.toBe(cache.source({ manifest, user: "u1", tenant: "o1" }));
  });

  it("keys the custom form on the queries and read objects", () => {
    const cache = powerSyncSourceCache(db);
    const manifest = localSnapshotManifest(policy);
    const queries = { roles: { sql: "roles" } };
    const read = () => ({ principal: { id: "u1", roles: [] } });
    const first = cache.source({ manifest, queries, read });
    expect(cache.source({ manifest, queries, read })).toBe(first);
    expect(
      cache.source({ manifest, queries: { roles: { sql: "roles" } }, read }),
    ).not.toBe(first);
    expect(
      cache.source({
        manifest,
        queries,
        read: () => ({ principal: { id: "u2", roles: [] } }),
      }),
    ).not.toBe(first);
  });

  it("keeps caches apart and is frozen", () => {
    const manifest = withRows();
    const one = powerSyncSourceCache(db);
    const two = powerSyncSourceCache(db);
    expect(Object.isFrozen(one)).toBe(true);
    expect(one.source({ manifest, user: "u1" })).not.toBe(
      two.source({ manifest, user: "u1" }),
    );
  });

  it("shares one getAll per query across consumers of a cached source", async () => {
    const getAll = vi.fn<PowerSyncWatchable["getAll"]>(async () => [{}]);
    const cache = powerSyncSourceCache({ getAll, watch: () => undefined });
    const options = {
      manifest: localSnapshotManifest(policy),
      queries: { roles: { sql: "roles" } },
      read: () => ({ principal: { id: "u1", roles: ["member"] } }),
    };
    const [a, b] = await Promise.all([
      cache.source(options).get(),
      cache.source(options).get(),
    ]);
    expect(a).toBe(b);
    expect(getAll).toHaveBeenCalledOnce();
  });

  it("throws for a manifest without rows, as powerSyncSource does", () => {
    const cache = powerSyncSourceCache(db);
    expect(() =>
      cache.source({ manifest: localSnapshotManifest(policy), user: "u1" }),
    ).toThrow(TypeError);
  });
});
