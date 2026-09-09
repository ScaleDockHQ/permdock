import type { ReactElement, ReactNode } from 'react';

import type { Snapshot } from '../core/interfaces.ts';

import { compact } from '../core/compact.ts';
import { PermDockProvider as ClientProvider } from '../react/provider.tsx';

export function renderClientProvider(options: {
  readonly snapshot: Snapshot | string;
  readonly endpoint: string;
  readonly tenant?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <ClientProvider
      {...compact({
        snapshot: options.snapshot,
        endpoint: options.endpoint,
        tenant: options.tenant,
      })}
    >
      {options.children}
    </ClientProvider>
  );
}
