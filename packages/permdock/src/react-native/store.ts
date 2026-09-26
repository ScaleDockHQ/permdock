import type { Snapshot } from '../core/interfaces.ts';
import type { ClientStore } from '../react/store.ts';
import type { NativePermDockProviderProps } from './types.ts';

import { compact } from '../core/compact.ts';
import { emptySnapshot } from '../core/from-snapshot.ts';
import { createClientStore } from '../react/store.ts';
import {
  acceptSnapshot,
  clearStorage,
  persistSnapshot,
  readStored,
  readStoredSync,
} from './storage.ts';

export type NativeStoreOptions = Omit<NativePermDockProviderProps, 'children'>;

function isJws(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

export function createNativeStore(options: NativeStoreOptions): ClientStore {
  const signed =
    typeof options.snapshot === 'string' && isJws(options.snapshot)
      ? options.snapshot
      : undefined;
  const seeded =
    options.snapshot === undefined || signed !== undefined
      ? undefined
      : typeof options.snapshot === 'string'
        ? acceptSnapshot(options.snapshot, options.subjectId)
        : acceptSnapshot(JSON.stringify(options.snapshot), options.subjectId);
  const sync =
    signed === undefined
      ? readStoredSync(options.storage, options.subjectId)
      : undefined;
  const snapshot = signed ?? seeded ?? sync?.snapshot ?? emptySnapshot();
  const tenant = options.tenant ?? sync?.tenant;
  // The boot hydrate must not overwrite storage an async read has not reached
  // yet; any later hydrate or clear makes that read obsolete.
  let booted = false;
  let touched = false;
  const store = createClientStore(
    compact({
      snapshot,
      endpoint: options.endpoint,
      snapshotUrl: options.snapshotUrl,
      approvals: options.approvals,
      tenant,
      fetch: options.fetch,
      headers: options.headers,
      maxAge: options.maxAge,
      verifier: options.verifier,
      server: false,
      onSnapshot: (next: Snapshot, nextTenant: string | undefined) => {
        if (!booted) {
          return;
        }
        touched = true;
        persistSnapshot(options.storage, next, nextTenant);
      },
      onClear: () => {
        touched = true;
        clearStorage(options.storage);
      },
    }),
  );
  booted = true;
  if (seeded !== undefined) {
    persistSnapshot(options.storage, seeded, tenant);
  }
  if (sync === undefined && seeded === undefined && signed === undefined) {
    void readStored(options.storage, options.subjectId).then((stored) => {
      if (!touched && stored.snapshot !== undefined) {
        store.replace(stored.snapshot);
      }
    });
  }
  return store;
}
