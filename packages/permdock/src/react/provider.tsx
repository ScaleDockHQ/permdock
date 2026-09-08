import { type ReactElement, useMemo } from 'react';

import type { PermDockProviderProps } from './types.ts';

import { compact } from '../core/compact.ts';
import { PermDockStoreContext } from './context.ts';
import { createClientStore } from './store.ts';

export function PermDockProvider(props: PermDockProviderProps): ReactElement {
  const store = useMemo(
    () =>
      createClientStore(
        compact({
          snapshot: props.snapshot,
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
    <PermDockStoreContext value={store}>{props.children}</PermDockStoreContext>
  );
}
