import type { ReactElement, ReactNode } from "react";

import type { Snapshot } from "../core/snapshot-types.ts";
import type { NextPermDockProviderProps } from "./types.ts";

import { compact } from "../core/compact.ts";
// Kept external by tsdown so it stays a "use client" module: a Server
// Component renders it as a client reference and passes the snapshot across.
import { PermDockProvider as ClientProvider } from "../react/provider-client.js";

type ClientProviderOptions = Omit<
  NextPermDockProviderProps,
  "snapshot" | "include" | "tenants" | "children"
> & {
  readonly snapshotPromise: PromiseLike<Snapshot | string>;
  readonly endpoint: string | false;
  readonly children: ReactNode;
};

export function renderClientProvider(
  options: ClientProviderOptions,
): ReactElement {
  return (
    <ClientProvider
      {...compact({
        snapshotPromise: options.snapshotPromise,
        endpoint: options.endpoint,
        snapshotUrl: options.snapshotUrl,
        approvals: options.approvals,
        tenant: options.tenant,
        headers: options.headers,
        maxAge: options.maxAge,
        approvalInterval: options.approvalInterval,
        suspend: options.suspend,
        defaults: options.defaults,
        messages: options.messages,
      })}
    >
      {options.children}
    </ClientProvider>
  );
}
