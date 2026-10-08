import { describe, expect, it } from "vitest";

import type { PowerSyncWatchable } from "../../src/react-native/powersync.ts";

import { localSnapshotManifest } from "../../src/core/local-manifest.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { powersyncSource } from "../../src/react-native/powersync.ts";
import { memoryStorage } from "../../src/react-native/storage.ts";
import {
  connectSource,
  createNativeStore,
} from "../../src/react-native/store.ts";
import { ownPost, permissions, policy } from "../fixtures/quick-start.ts";

type Row = { readonly user_id: string; readonly role: string };

function fakeDb(tables: Record<string, Row[]>): PowerSyncWatchable & {
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

describe("powersyncSource", () => {
  it("builds the snapshot from the watched rows and follows their changes", async () => {
    const tables: Record<string, Row[]> = {
      user_roles: [{ user_id: "u1", role: "member" }],
    };
    const db = fakeDb(tables);
    const source = powersyncSource(db, {
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
    const store = createNativeStore({
      storage: memoryStorage(),
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
    const server = await createPermDock(policy as never, {
      id: "u1",
      orgId: "o1",
      roles: ["member"],
    });
    const source = powersyncSource(fakeDb({ user_roles: [] }), {
      manifest: localSnapshotManifest(policy),
      queries: {},
      read: () => ({ principal: { id: "u1", roles: ["member"] } }),
    });
    const snapshot = await source.get();
    const store = createNativeStore({
      storage: memoryStorage(),
      subjectId: "u1",
      snapshot,
    });
    const { post } = permissions;
    expect(store.get().can(post.update, ownPost)).toBe(
      server.can(post.update, ownPost),
    );
  });
});
