/** A permission reference from the app's definitions; only its `key` is read. */
export type RlsPermissionRef = { readonly key: string };

/**
 * One private Realtime topic pattern, such as `org:{organization}:chat`:
 * `:`-separated segments, one of them `{<scope>}`, which holds the id of a
 * scope instance.
 */
export type RlsRealtimeTopic = {
  /** Receive broadcast and presence messages: `select` on `realtime.messages`. */
  readonly read: RlsPermissionRef;
  /** Send broadcast messages and track presence: `insert`. Absent: nobody may. */
  readonly write?: RlsPermissionRef;
};

export type RlsRealtime = {
  readonly topics: Readonly<Record<string, RlsRealtimeTopic>>;
};

/** One Storage bucket whose object paths start with a scope instance id. */
export type RlsStorageBucket = {
  readonly scope: string;
  /** The 1-based `storage.foldername(name)` entry that holds the id. Default 1. */
  readonly folder?: number;
  /** Download and list: `select` on `storage.objects`. */
  readonly read?: RlsPermissionRef;
  /** Upload and overwrite: `insert` and `update`. */
  readonly write?: RlsPermissionRef;
  readonly delete?: RlsPermissionRef;
};

export type RlsStorage = {
  readonly buckets: Readonly<Record<string, RlsStorageBucket>>;
};
