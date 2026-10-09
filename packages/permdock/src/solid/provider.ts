import {
  createComponent,
  createComputed,
  on,
  onCleanup,
  type JSX,
} from "solid-js";

import type { Snapshot } from "../core/interfaces.ts";
import type { PermDockProviderProps } from "./types.ts";

import { isPromiseLike } from "../client/source.ts";
import { adapterStore, liveOptions } from "../client/store-options.ts";
import { compact } from "../core/compact.ts";
import { emptySnapshot } from "../core/from-snapshot.ts";
import { PermDockContext } from "./context.ts";

type ProviderProps = Parameters<typeof PermDockContext.Provider>[0];

export function PermDockProvider(props: PermDockProviderProps): JSX.Element {
  const source = props.snapshot;
  const promised = isPromiseLike(source);
  // SAFETY: the only function the snapshot prop allows is an accessor of a snapshot or string.
  const read =
    typeof source === "function"
      ? (source as () => Snapshot | string | undefined)
      : undefined;
  // SAFETY: neither a promise nor an accessor, so it is the plain Snapshot or string the prop allows.
  const initial = promised
    ? undefined
    : read === undefined
      ? (source as Snapshot | string)
      : read();
  const store = adapterStore(
    compact({
      endpoint: props.endpoint,
      snapshotUrl: props.snapshotUrl,
      approvals: props.approvals,
      tenant: props.tenant,
      maxAge: props.maxAge,
      ...liveOptions(() => ({
        headers: props.headers,
        fetch: props.fetch,
        verifier: props.verifier,
      })),
    }),
    initial ?? emptySnapshot(),
  );
  createComputed(
    on(
      () => props.tenant,
      (next) => {
        if (next !== undefined) {
          store
            .get()
            .refresh({ tenant: next })
            .catch(() => undefined);
        }
      },
      { defer: true },
    ),
  );
  onCleanup(() => {
    store.dispose();
  });
  if (promised) {
    store.follow(source);
  } else if (read !== undefined) {
    // An accessor that is still `undefined` (a loading `createResource`)
    // keeps the store pending until its first value.
    let arrive: ((value: Snapshot | string) => void) | undefined;
    if (initial === undefined) {
      store.follow(
        new Promise<Snapshot | string>((resolve) => {
          arrive = resolve;
        }),
      );
    }
    // A computation, not an effect: effects under a suspended boundary are
    // deferred during hydration, which left the store pending for good.
    createComputed(
      on(
        read,
        (next) => {
          if (next === undefined) {
            return;
          }
          if (arrive === undefined) {
            store.replace(next);
            return;
          }
          arrive(next);
          arrive = undefined;
        },
        { defer: initial !== undefined },
      ),
    );
  }
  // SAFETY: Solid renders whatever children it is given; the prop is `unknown` so any JSX child fits.
  return createComponent(PermDockContext.Provider, {
    value: store,
    get children() {
      return props.children;
    },
  } as ProviderProps);
}
