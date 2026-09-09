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

export function createNativeStore(options: NativeStoreOptions): ClientStore {
  const seeded =
    options.snapshot === undefined
      ? undefined
      : typeof options.snapshot === 'string'
        ? acceptSnapshot(options.snapshot, options.subjectId)
        : acceptSnapshot(JSON.stringify(options.snapshot), options.subjectId);
  const sync = readStoredSync(options.storage, options.subjectId);
  const snapshot = seeded ?? sync?.snapshot ?? emptySnapshot();
  const tenant = options.tenant ?? sync?.tenant;
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
      onSnapshot: (next: Snapshot, nextTenant: string | undefined) => {
        persistSnapshot(options.storage, next, nextTenant);
      },
      onClear: () => {
        clearStorage(options.storage);
      },
    }),
  );
  if (sync === undefined && seeded === undefined) {
    void readStored(options.storage, options.subjectId).then((stored) => {
      if (stored.snapshot !== undefined) {
        store.replace(stored.snapshot);
      }
    });
  }
  return store;
}
