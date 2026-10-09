import type { ClientStore } from "../client/store.ts";
import type { Snapshot, SnapshotSource } from "../core/interfaces.ts";
import type {
  NativePermDockProviderProps,
  SubscribeForeground,
} from "./types.ts";

import { isJws } from "../client/source.ts";
import { adapterStore } from "../client/store-options.ts";
import { compact } from "../core/compact.ts";
import { emptySnapshot } from "../core/from-snapshot.ts";
import { parseSnapshot } from "../core/snapshot.ts";
import {
  clearStorage,
  guardStorage,
  persistSnapshot,
  readStored,
  readStoredSync,
  type Stored,
} from "./storage.ts";

export type NativeStoreOptions = Omit<
  NativePermDockProviderProps,
  "children" | "headers"
> & {
  readonly headers?:
    | Readonly<Record<string, string>>
    | (() => Readonly<Record<string, string>> | undefined);
  /** A store this one replaces: its snapshot and tenant seed this store, so guards do not flip while it boots. */
  readonly previous?: ClientStore;
};

/** The snapshot's content without `issuedAt`, which every local rebuild changes. */
function contentKey(snapshot: Snapshot): string {
  return JSON.stringify({ ...snapshot, issuedAt: 0 });
}

/**
 * Whether a source read changes nothing: same content as the snapshot the
 * store holds, and the store already settled on it.
 */
function unchanged(store: ClientStore, next: Snapshot | string): boolean {
  if (typeof next === "string" || store.get().status() === "stale") {
    return false;
  }
  try {
    return contentKey(parseSnapshot(next)) === contentKey(store.snapshot());
  } catch {
    return false;
  }
}

/**
 * Hydrates `store` from `source` now, on every change it reports and on each
 * return to the foreground. Only the latest read applies; a read with
 * unchanged content re-renders nothing, and a failed read keeps the current
 * snapshot. Returns the unsubscribe.
 */
export function connectSource(
  store: ClientStore,
  source: SnapshotSource,
  subscribeForeground?: SubscribeForeground,
): () => void {
  let active = true;
  let seq = 0;
  const pull = (): void => {
    seq += 1;
    const mine = seq;
    void Promise.resolve()
      .then(() => source.get())
      .then(
        (next) => {
          if (active && mine === seq && !unchanged(store, next)) {
            store.replace(next);
          }
        },
        () => undefined,
      );
  };
  pull();
  const unsubscribe = source.subscribe?.(pull);
  const offForeground = subscribeForeground?.((next) => {
    if (next !== false) {
      pull();
    }
  });
  return (): void => {
    active = false;
    unsubscribe?.();
    offForeground?.();
  };
}

function seedOf(stored: Stored | undefined): Snapshot | string | undefined {
  if (stored === undefined) {
    return undefined;
  }
  return stored.kind === "signed" ? stored.jws : stored.snapshot;
}

function belongsTo(snapshot: Snapshot, subjectId: string | null): boolean {
  return subjectId !== null && snapshot.subject.principal?.id === subjectId;
}

/** A JWS stays a string for the verifier; anything else parses or is dropped. */
function parseSeed(
  given: NativeStoreOptions["snapshot"],
): Snapshot | string | undefined {
  if (given === undefined) {
    return undefined;
  }
  if (typeof given === "string" && isJws(given)) {
    return given;
  }
  try {
    return parseSnapshot(typeof given === "string" ? JSON.parse(given) : given);
  } catch {
    return undefined;
  }
}

export function createNativeStore(options: NativeStoreOptions): ClientStore {
  const storage = guardStorage(options.storage);
  const signed = options.verifier !== undefined;
  const revalidates =
    options.snapshotUrl !== undefined || options.source !== undefined;
  const seeded = parseSeed(options.snapshot);
  const carried =
    options.previous !== undefined &&
    belongsTo(options.previous.snapshot(), options.subjectId)
      ? options.previous
      : undefined;
  const sync =
    seeded === undefined && carried === undefined
      ? readStoredSync(storage, options.subjectId, signed)
      : undefined;
  const waiting =
    seeded === undefined && carried === undefined && sync === undefined;
  const fromStorage = seedOf(sync?.stored);
  const snapshot =
    seeded ?? carried?.snapshot() ?? fromStorage ?? emptySnapshot();
  const tenant =
    options.tenant ?? carried?.tenant() ?? sync?.tenant ?? undefined;
  // A boot or carried snapshot is already in storage; only later answers are written.
  let booted = false;
  const store = adapterStore(
    compact({
      endpoint: options.endpoint,
      snapshotUrl: options.snapshotUrl,
      approvals: options.approvals,
      tenant,
      fetch: options.fetch,
      headers: options.headers,
      maxAge: options.maxAge,
      verifier: options.verifier,
      awaiting: waiting,
      passCache: true,
    }),
    snapshot,
    {
      server: false,
      stale: revalidates && (fromStorage !== undefined || waiting),
      onSnapshot: (next, nextTenant, raw) => {
        if (!booted || !belongsTo(next, options.subjectId)) {
          return;
        }
        if (signed && raw === undefined) {
          return;
        }
        persistSnapshot(storage, raw ?? JSON.stringify(next), nextTenant);
      },
      onClear: () => {
        clearStorage(storage);
      },
    },
  );
  booted = true;
  if (seeded !== undefined && typeof seeded !== "string") {
    if (belongsTo(seeded, options.subjectId)) {
      persistSnapshot(storage, JSON.stringify(seeded), tenant);
    }
  } else if (seeded !== undefined && signed) {
    persistSnapshot(storage, seeded, tenant);
  }
  if (options.subjectId === null) {
    clearStorage(storage);
  }
  if (waiting) {
    let storedTenant: string | undefined;
    const read = readStored(storage, options.subjectId, signed).then(
      ({ stored, tenant: persisted }) => {
        const value = seedOf(stored);
        if (value === undefined) {
          throw new Error("nothing stored");
        }
        storedTenant = persisted;
        return value;
      },
    );
    store.track(read);
    // Runs after the store hydrated from `read`: callbacks run in registration order.
    read.then(
      () => {
        if (
          options.tenant === undefined &&
          storedTenant !== undefined &&
          store.tenant() !== storedTenant &&
          store.snapshot().tenants.includes(storedTenant)
        ) {
          void store.get().refresh({ tenant: storedTenant });
        }
      },
      () => undefined,
    );
  }
  return store;
}
