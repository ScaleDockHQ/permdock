import { createComponent, createComputed, on, type JSX } from 'solid-js';

import type { Snapshot } from '../core/interfaces.ts';
import type { PermDockProviderProps } from './types.ts';

import { compact } from '../core/compact.ts';
import { emptySnapshot } from '../core/from-snapshot.ts';
import { isPromiseLike } from '../react/source.ts';
import { createClientStore } from '../react/store.ts';
import { PermDockContext } from './context.ts';

export function PermDockProvider(props: PermDockProviderProps): JSX.Element {
  const source = props.snapshot;
  const promised = isPromiseLike(source);
  // SAFETY: the only function the snapshot prop allows is an accessor of a snapshot or string.
  const read =
    typeof source === 'function'
      ? (source as () => Snapshot | string | undefined)
      : undefined;
  // SAFETY: neither a promise nor an accessor, so it is the plain Snapshot or string the prop allows.
  const initial = promised
    ? undefined
    : read === undefined
      ? (source as Snapshot | string)
      : read();
  const store = createClientStore(
    compact({
      snapshot: initial ?? emptySnapshot(),
      endpoint: props.endpoint,
      approvals: props.approvals,
      tenant: props.tenant,
      fetch: props.fetch,
      headers: props.headers,
      maxAge: props.maxAge,
      verifier: props.verifier,
    }),
  );
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
  return createComponent(PermDockContext.Provider, {
    value: store,
    get children() {
      return props.children;
    },
  });
}
