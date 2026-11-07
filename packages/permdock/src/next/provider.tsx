import type { ReactElement, ReactNode } from "react";

import type { Snapshot } from "../core/snapshot-types.ts";
import type { NextPermDockProviderProps } from "./types.ts";

import { compact } from "../core/compact.ts";
import { PermDockProvider as LazyClientProvider } from "../react/provider-client-lazy.js";
// Kept external by tsdown so it stays a "use client" module: a Server
// Component renders it as a client reference and passes the snapshot across.
import { PermDockProvider as ClientProvider } from "../react/provider-client.js";

type ClientProviderOptions = Omit<
  NextPermDockProviderProps,
  "snapshot" | "include" | "tenants" | "children"
> & {
  readonly snapshotPromise: PromiseLike<Snapshot | string>;
  readonly endpoint: string | false;
  /** `"lazy"` renders the provider that loads the evaluator on demand. */
  readonly evaluator?: "eager" | "lazy";
  readonly children: ReactNode;
};

export function renderClientProvider(
  options: ClientProviderOptions,
): ReactElement {
  const { children, evaluator, ...props } = options;
  const Provider = evaluator === "lazy" ? LazyClientProvider : ClientProvider;
  return <Provider {...compact(props)}>{children}</Provider>;
}
