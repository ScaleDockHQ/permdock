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
  const { children, ...props } = options;
  return <ClientProvider {...compact(props)}>{children}</ClientProvider>;
}
