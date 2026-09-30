import type { Snapshot } from '../core/interfaces.ts';
import type { PermDockStorage } from './types.ts';

import { parseSnapshot } from '../core/snapshot.ts';

export const SNAPSHOT_KEY = 'permdock.snapshot';
const TENANT_KEY = 'permdock.tenant';

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

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

export function acceptSnapshot(
  raw: string | null,
  subjectId: string | undefined,
): Snapshot | undefined {
  if (raw === null || raw.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const snapshot = parseSnapshot(parsed);
    const id = snapshot.subject.principal?.id;
    if (subjectId !== undefined && id !== subjectId) {
      return undefined;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

export async function readStored(
  storage: PermDockStorage,
  subjectId: string | undefined,
): Promise<{
  readonly snapshot: Snapshot | undefined;
  readonly tenant: string | undefined;
}> {
  const raw = await Promise.resolve(storage.getItem(SNAPSHOT_KEY));
  const tenantRaw = await Promise.resolve(storage.getItem(TENANT_KEY));
  return {
    snapshot: acceptSnapshot(raw, subjectId),
    tenant:
      tenantRaw === null || tenantRaw.length === 0 ? undefined : tenantRaw,
  };
}

export function readStoredSync(
  storage: PermDockStorage,
  subjectId: string | undefined,
):
  | {
      readonly snapshot: Snapshot | undefined;
      readonly tenant: string | undefined;
    }
  | undefined {
  const raw = storage.getItem(SNAPSHOT_KEY);
  const tenantRaw = storage.getItem(TENANT_KEY);
  if (isThenable(raw) || isThenable(tenantRaw)) {
    return undefined;
  }
  return {
    snapshot: acceptSnapshot(raw, subjectId),
    tenant:
      tenantRaw === null || tenantRaw.length === 0 ? undefined : tenantRaw,
  };
}

export function persistSnapshot(
  storage: PermDockStorage,
  snapshot: Snapshot,
  tenant: string | undefined,
): void {
  const write = storage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  if (isThenable(write)) {
    write.catch(() => undefined);
  }
  if (tenant === undefined) {
    return;
  }
  const next = storage.setItem(TENANT_KEY, tenant);
  if (isThenable(next)) {
    next.catch(() => undefined);
  }
}

export function clearStorage(storage: PermDockStorage): void {
  const snap = storage.removeItem(SNAPSHOT_KEY);
  if (isThenable(snap)) {
    snap.catch(() => undefined);
  }
  const tenant = storage.removeItem(TENANT_KEY);
  if (isThenable(tenant)) {
    tenant.catch(() => undefined);
  }
}
