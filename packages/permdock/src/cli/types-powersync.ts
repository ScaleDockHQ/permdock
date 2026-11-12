/**
 * `permdock powersync generate` and `verify` input. Tables and memberships come
 * from `rls`.
 */
export type PowerSyncConfig = {
  /** The Sync Streams file; default `sync-config.yaml`. */
  readonly out?: string;
  /**
   * The only resources that get a stream. A helper does not add one. None when
   * omitted.
   */
  readonly resources?: readonly string[];
  /** The action whose grants decide which rows sync; default `read`. */
  readonly action?: string;
  /**
   * Where `generate` writes `localSnapshotManifest(policy)` as JSON for
   * `localSnapshot` and `powerSyncSource`; none by default.
   */
  readonly manifest?: string;
  /**
   * Tables that are not resources, by `schema.table`, each synced as its own
   * stream: the user's own rows, the rows that point at a resource row the user
   * reads, or both.
   */
  readonly tables?: Readonly<Record<string, PowerSyncTable>>;
  /**
   * Per resource, the membership column that narrows what a device syncs: a
   * member with no value or `all` syncs the tenant's rows, `own` the rows of
   * the resource's `own` level, `team` those of its `team` level. A resource
   * without an entry syncs the tenant's rows to every member.
   */
  readonly memberLevel?: Readonly<Record<string, PowerSyncMemberLevel>>;
};

export type PowerSyncMemberLevel = {
  /**
   * `table` or `schema.table` of the tenant scope's membership table, as
   * `rls.memberships` or a membership source names it.
   */
  readonly table: string;
  /** The text column on that table holding `own`, `team` or `all`. */
  readonly column: string;
};

export type PowerSyncTable = {
  /** The user id column: the stream holds the rows whose column is the user. */
  readonly user?: string;
  /** The resources a row points at; the stream holds rows of any of them. */
  readonly follow?: readonly PowerSyncFollow[];
};

/**
 * A row points at a `resource` row through `field`, which holds its id; `match`
 * keeps the rows whose columns equal the given values, for a table whose rows
 * point at several resources.
 */
export type PowerSyncFollow = {
  readonly resource: string;
  readonly field: string;
  readonly match?: Readonly<Record<string, string>>;
};
