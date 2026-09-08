import { createComponent } from 'solid-js';

import type { PermDockProviderProps } from './types.ts';

import { compact } from '../core/compact.ts';
import { createClientStore } from '../react/store.ts';
import { PermDockContext } from './context.ts';

export function PermDockProvider(props: PermDockProviderProps): unknown {
  const store = createClientStore(
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
  );
  return createComponent(PermDockContext.Provider, {
    value: store,
    get children() {
      return props.children;
    },
  });
}
