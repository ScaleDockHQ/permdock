import { type ReactElement, useMemo } from 'react';

import type { PermDockProviderProps } from './types.ts';

import { compact } from '../core/compact.ts';
import { emptySnapshot } from '../core/from-snapshot.ts';
import {
  PermDockSnapshotPromiseContext,
  PermDockStoreContext,
} from './context.ts';
import { createClientStore } from './store.ts';

export function PermDockProvider(props: PermDockProviderProps): ReactElement {
  const promise = props.snapshotPromise ?? null;
  const store = useMemo(
    () =>
      createClientStore(
        compact({
          snapshot: props.snapshot ?? emptySnapshot(),
          endpoint: props.endpoint,
          approvals: props.approvals,
          tenant: props.tenant,
          fetch: props.fetch,
          headers: props.headers,
          maxAge: props.maxAge,
          verifier: props.verifier,
        }),
      ),
    [
      props.snapshot,
      props.endpoint,
      props.approvals,
      props.tenant,
      props.fetch,
      props.headers,
      props.maxAge,
      props.verifier,
    ],
  );
  return (
    <PermDockStoreContext value={store}>
      <PermDockSnapshotPromiseContext value={promise}>
        {props.children}
      </PermDockSnapshotPromiseContext>
    </PermDockStoreContext>
  );
}
