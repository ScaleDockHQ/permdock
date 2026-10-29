import type { SnapshotSource } from "../core/interfaces.ts";
import type {
  LocalSnapshotManifest,
  Snapshot,
} from "../core/snapshot-types.ts";
import type { LocalSnapshotData } from "./local.ts";
import type { RowPrincipal } from "./powersync-rows.ts";

import { compact, isRecord } from "../core/compact.ts";
import { isMembershipExpired } from "../core/tenancy.ts";
import { buildLocalSnapshot } from "./local.ts";
import { quoted, readRows, rowQuery, rowTables } from "./powersync-rows.ts";

/** The `PowerSyncDatabase` methods `powerSyncSource` calls. */
export type PowerSyncWatchable = {
  getAll: (sql: string, parameters?: unknown[]) => Promise<unknown[]>;
  watch: (
    sql: string,
    parameters: unknown[] | undefined,
    handler: {
      onResult: (result: unknown) => void;
      onError?: (error: Error) => void;
    },
    options: { readonly signal: AbortSignal },
  ) => void;
};

/** One local query: SQL over the synced tables and its parameters. */
export type PowerSyncQuery = {
  readonly sql: string;
  readonly parameters?: readonly unknown[];
};

export type PowerSyncSourceOptions<Q extends string> =
  | {
      /**
       * `localSnapshotManifest(policy)`, as `permdock powersync generate`
       * writes it to `powersync.manifest`.
       */
      readonly manifest: LocalSnapshotManifest;
      /** The queries over the `permdock_*` streams' tables; each one is watched. */
      readonly queries: Readonly<Record<Q, PowerSyncQuery>>;
      /**
       * Maps the rows of each query to the signed-in user's memberships and
       * roles.
       */
      readonly read: (
        rows: Readonly<Record<Q, readonly unknown[]>>,
      ) => LocalSnapshotData;
    }
  | {
      /**
       * The manifest `permdock powersync generate` writes, with its `rows`
       * section.
       */
      readonly manifest: LocalSnapshotManifest;
      /**
       * The signed-in user's id; the source reads the rows `manifest.rows`
       * names.
       */
      readonly user: string;
      /** The active tenant: the first scope's instance the UI shows. */
      readonly tenant?: string;
      /**
       * Attributes conditions read, such as `claims` for
       * `principal.claims.team_ids`.
       */
      readonly attributes?: Readonly<Record<string, unknown>>;
      readonly queries?: undefined;
      readonly read?: undefined;
    };

/** A `powerSyncSource`: a snapshot source that also reads the synced version. */
export type PowerSyncSnapshotSource = SnapshotSource & {
  /**
   * The signed-in user's synced `authz_ver`, read from `manifest.rows.version`.
   * `undefined` without `user`, without that table, or before its row syncs.
   */
  readonly authzVersion: () => Promise<number | undefined>;
};

type Plan = {
  readonly queries: Readonly<Record<string, PowerSyncQuery>>;
  readonly read: (
    rows: Readonly<Record<string, readonly unknown[]>>,
  ) => LocalSnapshotData;
};

/** The query over `permdock_authz_version` the manifest names, by user id. */
export function authzVersionQuery(
  version: NonNullable<NonNullable<LocalSnapshotManifest["rows"]>["version"]>,
): string {
  return `SELECT ${quoted(version.version)} AS version FROM ${quoted(version.table)} WHERE ${quoted(version.user)} = ?`;
}

/** The highest non-negative integer `version` among `rows`. */
export function highestVersion(rows: readonly unknown[]): number | undefined {
  let found: number | undefined;
  for (const row of rows) {
    const value = Number(isRecord(row) ? row["version"] : undefined);
    if (
      Number.isSafeInteger(value) &&
      value >= 0 &&
      (found === undefined || value > found)
    ) {
      found = value;
    }
  }
  return found;
}

function planOf<Q extends string>(options: PowerSyncSourceOptions<Q>): Plan {
  if (!("user" in options)) {
    // SAFETY: read takes a Record<Q, …> and get passes one entry per key of queries.
    return options as Plan;
  }
  const { rows } = options.manifest;
  if (rows === undefined) {
    throw new TypeError(
      "PermDock: powerSyncSource needs queries and read, or a manifest with rows (run permdock powersync generate with powersync.manifest)",
    );
  }
  const principal = compact<RowPrincipal>({
    id: options.user,
    tenant: options.tenant,
    attributes: options.attributes,
  });
  return {
    queries: Object.fromEntries(
      rowTables(rows).map((table) => [table, { sql: rowQuery(table) }]),
    ),
    read: (tables) => readRows(rows, tables, principal),
  };
}

/**
 * A `localSnapshot` source over a PowerSync database: `get` initially runs
 * every query with `db.getAll`; watch-triggered reads refresh only fired
 * queries. Without `queries` and `read`, it reads the tables `manifest.rows`
 * names: the memberships of every source with null roles dropped, the global
 * roles and the custom roles with their levels. A watch result with unchanged
 * content re-renders nothing (`connectSource`). The source takes the database
 * as an argument; `permdock/react-native` never imports `@powersync/*`.
 */
export function powerSyncSource<Q extends string>(
  db: PowerSyncWatchable,
  options: PowerSyncSourceOptions<Q>,
): PowerSyncSnapshotSource {
  const plan = planOf(options);
  const version = options.manifest.rows?.version;
  const user = "user" in options ? options.user : undefined;
  const queries = Object.entries(plan.queries);
  const rows = new Map<string, readonly unknown[]>();
  const dirty = new Set<string>();
  const listeners = new Set<() => void>();
  let scheduled = false;
  let pending: Promise<Snapshot> | undefined;
  let snapshot: Snapshot | undefined;
  let content: string | undefined;

  const invalidate = (name: string): void => {
    dirty.add(name);
    if (scheduled) {
      return;
    }
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      for (const listener of listeners) {
        listener();
      }
    });
  };

  const read = async (): Promise<Snapshot> => {
    // An explicit pull (including foreground refresh) must not trust a quiet watch.
    if (dirty.size === 0) {
      for (const [name] of queries) {
        dirty.add(name);
      }
    }
    do {
      const selected = queries.filter(
        ([name]) => dirty.has(name) || !rows.has(name),
      );
      for (const [name] of selected) {
        dirty.delete(name);
      }
      try {
        // A second batch depends on watch callbacks delivered during the previous read.
        // oxlint-disable-next-line eslint/no-await-in-loop
        const results = await Promise.all(
          selected.map(
            async ([name, query]) =>
              [
                name,
                await db.getAll(query.sql, [...(query.parameters ?? [])]),
              ] as const,
          ),
        );
        for (const [name, result] of results) {
          rows.set(name, result);
        }
      } catch (error) {
        for (const [name] of selected) {
          dirty.add(name);
        }
        throw error;
      }
      // A watch can fire while getAll is pending; never publish that older read.
    } while (dirty.size > 0);
    const data = plan.read(Object.fromEntries(rows));
    const next = JSON.stringify([
      data,
      data.principal?.memberships?.map((membership) =>
        isMembershipExpired(membership),
      ),
    ]);
    if (snapshot === undefined || next !== content) {
      snapshot = buildLocalSnapshot(options.manifest, data);
      content = next;
    }
    return snapshot;
  };

  return {
    authzVersion: async () =>
      version === undefined || user === undefined
        ? undefined
        : highestVersion(await db.getAll(authzVersionQuery(version), [user])),
    get: () => {
      pending ??= read().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      const controller = new AbortController();
      for (const [name, query] of queries) {
        db.watch(
          query.sql,
          [...(query.parameters ?? [])],
          {
            onResult: () => {
              invalidate(name);
            },
          },
          { signal: controller.signal },
        );
      }
      return () => {
        listeners.delete(listener);
        controller.abort();
      };
    },
  };
}

/** `powerSyncSource` over one database, memoised per manifest and options. */
export type PowerSyncSourceCache = {
  readonly source: <Q extends string>(
    options: PowerSyncSourceOptions<Q>,
  ) => PowerSyncSnapshotSource;
};

type Entries = {
  readonly rows: Map<string, PowerSyncSnapshotSource>;
  readonly custom: WeakMap<object, WeakMap<object, PowerSyncSnapshotSource>>;
};

/**
 * A cache of `powerSyncSource` sources over `db`. `source` answers the same
 * source for the same `manifest` object and, with `user`, the same `user`,
 * `tenant` and `attributes` content, or, with `queries`, the same `queries` and
 * `read` objects. A render that rebuilds its options then keeps the source, so
 * `PermDockProvider` neither resubscribes nor rereads. Entries live as long as
 * their manifest; create one cache per database, outside render.
 */
export function powerSyncSourceCache(
  db: PowerSyncWatchable,
): PowerSyncSourceCache {
  const byManifest = new WeakMap<LocalSnapshotManifest, Entries>();
  return Object.freeze({
    source: <Q extends string>(
      options: PowerSyncSourceOptions<Q>,
    ): PowerSyncSnapshotSource => {
      let entries = byManifest.get(options.manifest);
      if (entries === undefined) {
        entries = { rows: new Map(), custom: new WeakMap() };
        byManifest.set(options.manifest, entries);
      }
      if ("user" in options) {
        const key = JSON.stringify([
          options.user,
          options.tenant ?? null,
          options.attributes ?? null,
        ]);
        let source = entries.rows.get(key);
        if (source === undefined) {
          source = powerSyncSource(db, options);
          entries.rows.set(key, source);
        }
        return source;
      }
      let byRead = entries.custom.get(options.queries);
      if (byRead === undefined) {
        byRead = new WeakMap();
        entries.custom.set(options.queries, byRead);
      }
      let source = byRead.get(options.read);
      if (source === undefined) {
        source = powerSyncSource(db, options);
        byRead.set(options.read, source);
      }
      return source;
    },
  });
}
