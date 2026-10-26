import type { SnapshotSource } from "../core/interfaces.ts";
import type {
  LocalSnapshotManifest,
  Snapshot,
} from "../core/snapshot-types.ts";
import type { LocalSnapshotData } from "./local.ts";
import type { RowPrincipal } from "./powersync-rows.ts";

import { compact } from "../core/compact.ts";
import { isMembershipExpired } from "../core/tenancy.ts";
import { buildLocalSnapshot } from "./local.ts";
import { readRows, rowQuery, rowTables } from "./powersync-rows.ts";

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

type Plan = {
  readonly queries: Readonly<Record<string, PowerSyncQuery>>;
  readonly read: (
    rows: Readonly<Record<string, readonly unknown[]>>,
  ) => LocalSnapshotData;
};

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
): SnapshotSource {
  const plan = planOf(options);
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
