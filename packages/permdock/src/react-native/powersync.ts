import type {
  LocalSnapshotManifest,
  SnapshotSource,
} from "../core/interfaces.ts";
import type { LocalSnapshotData } from "./local.ts";

import { localSnapshot } from "./local.ts";

/** The `PowerSyncDatabase` methods `powersyncSource` calls. */
export type PowerSyncWatchable = {
  getAll(sql: string, parameters?: unknown[]): Promise<unknown[]>;
  watch(
    sql: string,
    parameters: unknown[] | undefined,
    handler: {
      onResult(result: unknown): void;
      onError?(error: Error): void;
    },
    options: { readonly signal: AbortSignal },
  ): void;
};

/** One local query: SQL over the synced tables and its parameters. */
export type PowerSyncQuery = {
  readonly sql: string;
  readonly parameters?: readonly unknown[];
};

export type PowerSyncSourceOptions<Q extends string> = {
  /** `localSnapshotManifest(policy)`, as `permdock powersync generate` writes it to `powersync.manifest`. */
  readonly manifest: LocalSnapshotManifest;
  /** The queries over the `permdock_*` streams' tables; each one is watched. */
  readonly queries: Readonly<Record<Q, PowerSyncQuery>>;
  /** Maps the rows of each query to the signed-in user's memberships and roles. */
  readonly read: (
    rows: Readonly<Record<Q, readonly unknown[]>>,
  ) => LocalSnapshotData;
};

/**
 * A `localSnapshot` source over a PowerSync database: `get` runs every query
 * with `db.getAll`, and a `db.watch` per query reports changes. A watch
 * result with unchanged content re-renders nothing (`connectSource`). The source
 * takes the database as an argument; `permdock/react-native` never imports
 * `@powersync/*`.
 */
export function powersyncSource<Q extends string>(
  db: PowerSyncWatchable,
  options: PowerSyncSourceOptions<Q>,
): SnapshotSource {
  // SAFETY: Object.keys of a Record<Q, …> lists only its Q keys.
  const names = Object.keys(options.queries) as Q[];
  return localSnapshot({
    manifest: options.manifest,
    read: async () => {
      const results = await Promise.all(
        names.map(async (name) => {
          const query = options.queries[name];
          return [
            name,
            await db.getAll(query.sql, [...(query.parameters ?? [])]),
          ] as const;
        }),
      );
      const rows: Partial<Record<Q, readonly unknown[]>> = {};
      for (const [name, list] of results) {
        rows[name] = list;
      }
      // SAFETY: names lists every Q key, and each one was assigned above.
      return options.read(rows as Record<Q, readonly unknown[]>);
    },
    subscribe: (listener) => {
      const controller = new AbortController();
      for (const name of names) {
        const query = options.queries[name];
        db.watch(
          query.sql,
          [...(query.parameters ?? [])],
          { onResult: listener },
          { signal: controller.signal },
        );
      }
      return () => {
        controller.abort();
      };
    },
  });
}
