import type { Snapshot } from "../core/interfaces.ts";
import type { PermDockStorage } from "./types.ts";

import { isJws } from "../client/source.ts";
import { parseSnapshot } from "../core/snapshot.ts";
import { isThenable } from "../core/thenable.ts";

export const SNAPSHOT_KEY = "permdock.snapshot";
export const TENANT_KEY = "permdock.tenant";

export function memoryStorage(
  initial: Readonly<Record<string, string>> = {},
): PermDockStorage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem(key: string): string | null {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      map.set(key, value);
    },
    removeItem(key: string): void {
      map.delete(key);
    },
  };
}

/** What a persisted value may become: a plain snapshot, or a compact JWS the verifier still has to check. */
export type Stored =
  | { readonly kind: "snapshot"; readonly snapshot: Snapshot }
  | { readonly kind: "signed"; readonly jws: string };

export type StoredRead = {
  readonly stored: Stored | undefined;
  readonly tenant: string | undefined;
};

const NOTHING: StoredRead = { stored: undefined, tenant: undefined };

/**
 * A persisted snapshot the device may use: `subjectId`'s own, and signed
 * whenever a verifier is configured, so a copy edited on the device never
 * stands in for a signed one. `null` reads nothing.
 */
export function acceptStored(
  raw: string | null,
  subjectId: string | null,
  signed: boolean,
): Stored | undefined {
  if (raw === null || raw.length === 0 || subjectId === null) {
    return undefined;
  }
  if (isJws(raw)) {
    return signed ? { kind: "signed", jws: raw } : undefined;
  }
  if (signed) {
    return undefined;
  }
  try {
    const snapshot = parseSnapshot(JSON.parse(raw));
    return snapshot.subject.principal?.id === subjectId
      ? { kind: "snapshot", snapshot }
      : undefined;
  } catch {
    return undefined;
  }
}

function tenantOf(raw: string | null): string | undefined {
  return raw === null || raw.length === 0 ? undefined : raw;
}

/** The tenant is read only alongside an accepted snapshot. */
function storedRead(
  raw: string | null,
  tenantRaw: string | null,
  subjectId: string,
  signed: boolean,
): StoredRead {
  const stored = acceptStored(raw, subjectId, signed);
  return {
    stored,
    tenant: stored === undefined ? undefined : tenantOf(tenantRaw),
  };
}

/**
 * The app's storage with every failure absorbed: a throwing or rejecting read
 * is an empty storage, a failing write keeps the in-memory answers, and
 * development builds warn once per store.
 */
export type GuardedStorage = {
  read(key: string): string | null | PromiseLike<string | null>;
  write(key: string, value: string): void;
  remove(key: string): void;
  fail(error: unknown): void;
};

export function guardStorage(storage: PermDockStorage): GuardedStorage {
  let warned = false;
  const fail = (error: unknown): void => {
    const dev = Reflect.get(globalThis, "__DEV__") === true;
    if (!dev || warned) {
      return;
    }
    warned = true;
    // oxlint-disable-next-line no-console -- one development hint per store whose storage fails
    console.warn(
      "PermDock: the snapshot storage failed; guards answer from memory until it works again.",
      error,
    );
  };
  const settle = (run: () => unknown): void => {
    try {
      const result = run();
      if (isThenable(result)) {
        Promise.resolve(result).catch(fail);
      }
    } catch (error) {
      fail(error);
    }
  };
  return {
    read(key) {
      try {
        return storage.getItem(key);
      } catch (error) {
        fail(error);
        return null;
      }
    },
    write(key, value) {
      settle(() => storage.setItem(key, value));
    },
    remove(key) {
      settle(() => storage.removeItem(key));
    },
    fail,
  };
}

/** `undefined` when the storage answers asynchronously; any failure reads as empty. */
export function readStoredSync(
  storage: GuardedStorage,
  subjectId: string | null,
  signed: boolean,
): StoredRead | undefined {
  if (subjectId === null) {
    return NOTHING;
  }
  const raw = storage.read(SNAPSHOT_KEY);
  const tenantRaw = storage.read(TENANT_KEY);
  if (isThenable(raw) || isThenable(tenantRaw)) {
    return undefined;
  }
  return storedRead(raw, tenantRaw, subjectId, signed);
}

export async function readStored(
  storage: GuardedStorage,
  subjectId: string | null,
  signed: boolean,
): Promise<StoredRead> {
  if (subjectId === null) {
    return NOTHING;
  }
  try {
    const [raw, tenantRaw] = await Promise.all([
      Promise.resolve(storage.read(SNAPSHOT_KEY)),
      Promise.resolve(storage.read(TENANT_KEY)),
    ]);
    return storedRead(raw, tenantRaw, subjectId, signed);
  } catch (error) {
    storage.fail(error);
    return NOTHING;
  }
}

/** Writes `raw` (the snapshot JSON or its JWS) and the tenant. */
export function persistSnapshot(
  storage: GuardedStorage,
  raw: string,
  tenant: string | undefined,
): void {
  storage.write(SNAPSHOT_KEY, raw);
  if (tenant !== undefined) {
    storage.write(TENANT_KEY, tenant);
  }
}

export function clearStorage(storage: GuardedStorage): void {
  storage.remove(SNAPSHOT_KEY);
  storage.remove(TENANT_KEY);
}
