import { describe, expect, it, vi } from "vitest";

import type { PowerSyncWatchable } from "../../src/react-native/powersync.ts";

import { principal } from "../../src/conditions/refs.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { localSnapshotManifest } from "../../src/core/local-manifest.ts";
import { memoryCustomRoleSource } from "../../src/core/memory-sources.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { powerSyncSource } from "../../src/react-native/powersync.ts";
import { memorySnapshotStorage } from "../../src/react-native/storage.ts";
import { connectSource, nativeStore } from "../../src/react-native/store.ts";
import { ownPost, permissions, policy } from "../fixtures/quick-start.ts";

type Row = { readonly user_id: string; readonly role: string };

function fakeDb(
  tables: Record<string, Row[]>,
): PowerSyncWatchable & {
  readonly change: () => void;
  readonly aborted: () => boolean;
} {
  const watchers = new Set<() => void>();
  let aborted = false;
  return {
    getAll: async (sql, parameters) => {
      const table = /FROM (\w+)/u.exec(sql)?.[1] ?? "";
      return (tables[table] ?? []).filter(
        (row) => row.user_id === parameters?.[0],
      );
    },
    watch: (_sql, _parameters, handler, options) => {
      const notify = (): void => {
        handler.onResult({});
      };
      watchers.add(notify);
      notify();
      options.signal.addEventListener("abort", () => {
        aborted = true;
        watchers.delete(notify);
      });
    },
    change: () => {
      for (const watcher of watchers) {
        watcher();
      }
    },
    aborted: () => aborted,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe(powerSyncSource, () => {
  it("coalesces watch bursts and rereads only the queries that fired", async () => {
    const calls: string[] = [];
    const handlers = new Map<string, () => void>();
    let roles = ["member"];
    const source = powerSyncSource(
      {
        getAll: async (sql) => {
          calls.push(sql);
          return sql === "roles" ? [...roles] : ["o1"];
        },
        watch: (sql, _parameters, handler) => {
          handlers.set(sql, () => handler.onResult({ ignored: true }));
        },
      },
      {
        manifest: localSnapshotManifest(policy),
        queries: { roles: { sql: "roles" }, org: { sql: "org" } },
        read: (rows) => ({
          principal: {
            id: "u1",
            roles: rows.roles.filter(
              (row): row is string => typeof row === "string",
            ),
          },
        }),
      },
    );
    let notifications = 0;
    const stop = source.subscribe?.(() => {
      notifications += 1;
    });
    const first = await source.get();
    expect(calls).toStrictEqual(["roles", "org"]);
    calls.length = 0;
    handlers.get("roles")?.();
    handlers.get("roles")?.();
    handlers.get("roles")?.();
    await settle();
    expect(notifications).toBe(1);
    expect(await source.get()).toBe(first);
    expect(calls).toStrictEqual(["roles"]);
    calls.length = 0;
    roles = ["admin"];
    handlers.get("roles")?.();
    handlers.get("org")?.();
    await settle();
    const changed = await source.get();
    expect(changed).not.toBe(first);
    if (typeof changed === "string") {
      throw new TypeError("Expected a local snapshot");
    }
    expect(changed.subject.principal?.roles).toStrictEqual(["admin"]);
    expect(calls).toStrictEqual(["roles", "org"]);
    stop?.();
    const beforeStop = notifications;
    handlers.get("roles")?.();
    await settle();
    expect(notifications).toBe(beforeStop);
  });

  it("keeps source caches isolated and refreshes on explicit pulls", async () => {
    const tables = { user_roles: [{ user_id: "u1", role: "member" }] };
    const db = fakeDb(tables);
    const create = (user: string) =>
      powerSyncSource(db, {
        manifest: localSnapshotManifest(policy),
        queries: {
          roles: {
            sql: "SELECT * FROM user_roles WHERE user_id = ?",
            parameters: [user],
          },
        },
        read: (rows) => ({
          principal: {
            id: user,
            roles: rows.roles.flatMap((row) =>
              typeof row === "object" &&
              row !== null &&
              "role" in row &&
              typeof row.role === "string"
                ? [row.role]
                : [],
            ),
          },
        }),
      });
    const first = create("u1");
    const other = create("u2");
    const original = await first.get();
    const isolated = await other.get();
    expect(isolated).not.toStrictEqual(original);
    tables.user_roles = [{ user_id: "u1", role: "admin" }];
    expect(await first.get()).not.toStrictEqual(original);
    expect(await other.get()).toBe(isolated);
  });

  it("retries failed reads and does not publish rows invalidated during a read", async () => {
    let fire: () => void = () => undefined;
    let finish: ((rows: unknown[]) => void) | undefined;
    let attempts = 0;
    const source = powerSyncSource(
      {
        getAll: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("offline");
          }
          if (attempts === 2) {
            return new Promise((resolve) => {
              finish = resolve;
            });
          }
          return ["member"];
        },
        watch: (_sql, _params, handler) => {
          fire = () => handler.onResult({});
        },
      },
      {
        manifest: localSnapshotManifest(policy),
        queries: { roles: { sql: "roles" } },
        read: (rows) => ({
          principal: {
            id: "u1",
            roles: rows.roles.filter(
              (row): row is string => typeof row === "string",
            ),
          },
        }),
      },
    );
    const stop = source.subscribe?.(() => undefined);
    await expect(source.get()).rejects.toThrow("offline");
    const pending = source.get();
    const concurrent = source.get();
    fire();
    finish?.(["admin"]);
    const snapshot = await pending;
    expect(await concurrent).toBe(snapshot);
    expect(attempts).toBe(3);
    if (typeof snapshot === "string") {
      throw new TypeError("Expected a local snapshot");
    }
    expect(snapshot.subject.principal?.roles).toStrictEqual(["member"]);
    stop?.();
  });

  it("rebuilds unchanged rows when a membership expires", async () => {
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-01-01T00:00:00Z"));
    try {
      const source = powerSyncSource(fakeDb({}), {
        manifest: localSnapshotManifest(policy),
        queries: {},
        read: () => ({
          principal: {
            id: "u1",
            memberships: [
              {
                scope: "org",
                id: "o1",
                roles: ["member"],
                expiresAt: Date.parse("2026-01-01T00:00:01Z") / 1000,
              },
            ],
          },
        }),
      });
      const before = await source.get();
      expect(await source.get()).toBe(before);
      clock.mockReturnValue(Date.parse("2026-01-01T00:00:02Z"));
      expect(await source.get()).not.toBe(before);
    } finally {
      clock.mockRestore();
    }
  });

  it("builds the snapshot from the watched rows and follows their changes", async () => {
    const tables: Record<string, Row[]> = {
      user_roles: [{ user_id: "u1", role: "member" }],
    };
    const db = fakeDb(tables);
    const source = powerSyncSource(db, {
      manifest: localSnapshotManifest(policy),
      queries: {
        roles: {
          sql: "SELECT * FROM user_roles WHERE user_id = ?",
          parameters: ["u1"],
        },
      },
      read: (rows) => ({
        principal: {
          id: "u1",
          roles: rows.roles.flatMap((row) =>
            typeof row === "object" && row !== null && "role" in row
              ? [String(row.role)]
              : [],
          ),
        },
      }),
    });
    const store = nativeStore({
      storage: memorySnapshotStorage(),
      subjectId: "u1",
    });
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    const stop = connectSource(store, source);
    await settle();
    const { post } = permissions;
    expect(store.get().can(post.read, ownPost)).toBe(true);
    expect(store.get().can(post.publish, ownPost)).toBe(false);
    const before = notified;
    db.change();
    await settle();
    expect(notified).toBe(before);
    tables["user_roles"] = [{ user_id: "u1", role: "admin" }];
    db.change();
    await settle();
    expect(store.get().can(post.publish, ownPost)).toBe(true);
    stop();
    expect(db.aborted()).toBe(true);
  });

  it("answers like the server for the same rows", async () => {
    // SAFETY: the quick-start user fixture; only the policy generic is erased.
    const server = getPermDockSync(policy as never, {
      id: "u1",
      orgId: "o1",
      roles: ["member"],
    });
    const source = powerSyncSource(fakeDb({ user_roles: [] }), {
      manifest: localSnapshotManifest(policy),
      queries: {},
      read: () => ({ principal: { id: "u1", roles: ["member"] } }),
    });
    const snapshot = await source.get();
    const store = nativeStore({
      storage: memorySnapshotStorage(),
      subjectId: "u1",
      snapshot,
    });
    const { post } = permissions;
    expect(store.get().can(post.update, ownPost)).toBe(
      server.can(post.update, ownPost),
    );
  });

  it("computes what a tenant member may hand out from the synced rows", async () => {
    const tenantPermissions = definePermissions({
      job: resource({
        id: "id",
        actions: ["read", "update"],
        relations: { org: { field: "orgId", memberOf: "tenant" } },
        levels: { own: { ownerId: principal.id }, all: {} },
      }),
    });
    const { job } = tenantPermissions;
    const tenantPolicy = definePolicy(tenantPermissions, {
      scopes: { tenant: { key: "orgId" } },
      subject: () => null,
      roles: [
        role("admin", [allow([job.read, job.update])], { on: "tenant" }),
        role(
          "manager",
          [
            allow(job.read),
            allow(job.update, { where: { ownerId: principal.id } }),
          ],
          { on: "tenant" },
        ),
      ],
    });
    const customRoles = [
      {
        tenant: "acme",
        name: "self-service",
        grants: [{ permission: "job.update", level: "own" }],
      },
      {
        tenant: "acme",
        name: "editor",
        grants: [{ permission: "job.update" }],
      },
    ];
    const memberships = [{ scope: "tenant", id: "acme", roles: ["manager"] }];
    const server = getPermDockSync(
      tenantPolicy,
      { principal: { id: "u1", tenant: "acme", memberships }, context: {} },
      { tenant: "acme", customRoles: memoryCustomRoleSource(customRoles) },
    );
    const source = powerSyncSource(fakeDb({}), {
      manifest: localSnapshotManifest(tenantPolicy),
      queries: {},
      read: () => ({
        principal: { id: "u1", tenant: "acme", memberships },
        customRoles,
      }),
    });
    const store = nativeStore({
      storage: memorySnapshotStorage(),
      subjectId: "u1",
      snapshot: await source.get(),
    });
    const device = store.get();
    expect(
      device.assignablePermissions().map((leaf) => leaf.key),
    ).toStrictEqual(["job.read", "job.update"]);
    expect(device.assignableLevels(job.update)).toStrictEqual(["own"]);
    expect(device.assignableRoles().map((leaf) => leaf.key)).toStrictEqual(
      server.assignableRoles().map((leaf) => leaf.key),
    );
    expect(device.assignableRoles().map((leaf) => leaf.key)).toContain(
      "self-service",
    );
    expect(device.assignableRoles().map((leaf) => leaf.key)).not.toContain(
      "editor",
    );
  });
});
