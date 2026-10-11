import type { ReactElement, ReactNode } from "react";

import type { Snapshot } from "../core/interfaces.ts";
import type { ServerPermDockProviderProps } from "./types.ts";

import { compact } from "../core/compact.ts";
// Kept external by tsdown so it stays a "use client" module: a Server
// Component renders it as a client reference and passes the snapshot across.
import { PermDockProvider as ClientProvider } from "../react/provider-client.js";

export function renderClientProvider(options: {
  readonly snapshotPromise: PromiseLike<Snapshot | string>;
  readonly endpoint: string | false;
  readonly tenant?: string;
  readonly suspend?: boolean;
  readonly defaults?: ServerPermDockProviderProps["defaults"];
  readonly messages?: ServerPermDockProviderProps["messages"];
  readonly children: ReactNode;
}): ReactElement {
  return (
    <ClientProvider
      {...compact({
        snapshotPromise: options.snapshotPromise,
        endpoint: options.endpoint,
        tenant: options.tenant,
        suspend: options.suspend,
        defaults: options.defaults,
        messages: options.messages,
      })}
    >
      {options.children}
    </ClientProvider>
  );
}
