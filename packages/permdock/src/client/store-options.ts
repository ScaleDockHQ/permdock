import type { Snapshot, TokenVerifier } from "../core/interfaces.ts";
import type { Permission } from "../core/permissions.ts";
import type { ClientStore, ClientStoreOptions } from "../react/store.ts";

import { compact } from "../core/compact.ts";
import { createClientStore } from "../react/store.ts";

/** The provider options every UI adapter forwards to its client store. */
export type AdapterStoreOptions = Pick<
  ClientStoreOptions,
  | "snapshotUrl"
  | "approvals"
  | "tenant"
  | "fetch"
  | "headers"
  | "maxAge"
  | "verifier"
  | "awaiting"
  | "passCache"
> & {
  /**
   * The AuthZEN evaluations endpoint. `false` never calls one: a check the
   * snapshot cannot answer is denied with reason `server-only`, and the first
   * one logs a hint.
   */
  readonly endpoint?: string | false;
};

type Headers = Readonly<Record<string, string>>;

/** One hint per store: the first check `endpoint: false` turns into a `server-only` denial. */
function hintOnce(): (permission: Permission) => void {
  let shown = false;
  return (permission) => {
    if (shown) {
      return;
    }
    shown = true;
    // oxlint-disable-next-line no-console -- the one hint for snapshot-only mode
    console.info(
      `PermDock: ${permission.key} needs the server (a closure, graph relation or period grant) and endpoint is false, so it is denied with reason server-only; check it on the server instead`,
    );
  };
}

export function adapterStore(
  options: AdapterStoreOptions,
  snapshot: Snapshot | string,
): ClientStore {
  return createClientStore(
    compact({
      snapshot,
      endpoint: options.endpoint === false ? undefined : options.endpoint,
      onServerOnly: options.endpoint === false ? hintOnce() : undefined,
      snapshotUrl: options.snapshotUrl,
      approvals: options.approvals,
      tenant: options.tenant,
      fetch: options.fetch,
      headers: options.headers,
      maxAge: options.maxAge,
      verifier: options.verifier,
      awaiting: options.awaiting,
      passCache: options.passCache,
    }),
  );
}

/**
 * Store options that read `read()` on every request, so a rotated token, a
 * new `fetch` or a new verifier applies without rebuilding the store. A
 * verifier is wired only when one is present at creation: it switches the
 * store to signed snapshots.
 */
export function liveOptions(
  read: () => {
    readonly headers?: Headers | undefined;
    readonly fetch?: typeof fetch | undefined;
    readonly verifier?: TokenVerifier | undefined;
  },
): Pick<AdapterStoreOptions, "headers" | "fetch" | "verifier"> {
  const verifier: TokenVerifier = {
    verify: (token, expectations) => {
      const current = read().verifier;
      return current === undefined
        ? Promise.reject(
            new Error("PermDock: the verifier option was removed."),
          )
        : current.verify(token, expectations);
    },
  };
  return compact({
    headers: () => read().headers,
    fetch: (...args: Parameters<typeof fetch>): Promise<Response> =>
      (read().fetch ?? fetch)(...args),
    verifier: read().verifier === undefined ? undefined : verifier,
  });
}
