import { useLayoutEffect, useRef, useState } from "react";

import type { ClientStoreOptions } from "../client/store.ts";
import type { TokenVerifier } from "../core/interfaces.ts";

type Headers = Readonly<Record<string, string>>;
type OnSnapshot = NonNullable<ClientStoreOptions["onSnapshot"]>;

type LiveProps = {
  readonly headers?: Headers | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly verifier?: TokenVerifier | undefined;
  readonly onSnapshot?: OnSnapshot | undefined;
  readonly onClear?: (() => void) | undefined;
};

export type LiveOptions = {
  readonly headers: Headers | undefined;
  /** The latest `headers` prop, read on every request without rebuilding the store. */
  readonly readHeaders: () => Headers | undefined;
  readonly fetch: typeof fetch;
  readonly verifier: TokenVerifier | undefined;
  /** Call the latest `onSnapshot` / `onClear` prop; set while the prop is. */
  readonly onSnapshot: OnSnapshot | undefined;
  readonly onClear: (() => void) | undefined;
};

function sameHeaders(a: Headers | undefined, b: Headers | undefined): boolean {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
}

/**
 * Store options whose identity survives a re-render, so an inline `headers`
 * object or `fetch` arrow does not rebuild the store and drop its snapshot.
 * `headers` compare by value, unless `headersByValue` is `false` for a store
 * that only reads `readHeaders`; `fetch`, `verifier`, `onSnapshot` and
 * `onClear` call the latest prop.
 */
export function useLiveOptions(
  props: LiveProps,
  headersByValue = true,
): LiveOptions {
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const [headers, setHeaders] = useState(props.headers);
  if (headersByValue && !sameHeaders(headers, props.headers)) {
    setHeaders(props.headers);
  }
  const [readHeaders] = useState(
    () => (): Headers | undefined => latest.current.headers,
  );
  const [liveFetch] = useState(
    () =>
      (...args: Parameters<typeof fetch>): Promise<Response> =>
        (latest.current.fetch ?? fetch)(...args),
  );
  const [liveVerifier] = useState<TokenVerifier>(() => ({
    verify: (token, expectations): ReturnType<TokenVerifier["verify"]> => {
      const verifier = latest.current.verifier;
      return verifier === undefined
        ? Promise.reject(new Error("PermDock: the verifier prop was removed."))
        : verifier.verify(token, expectations);
    },
  }));
  const [liveOnSnapshot] = useState(() => {
    const call: OnSnapshot = (snapshot, tenant, raw) => {
      latest.current.onSnapshot?.(snapshot, tenant, raw);
    };
    return call;
  });
  const [liveOnClear] = useState(() => (): void => {
    latest.current.onClear?.();
  });
  return {
    headers,
    readHeaders,
    fetch: liveFetch,
    verifier: props.verifier === undefined ? undefined : liveVerifier,
    onSnapshot: props.onSnapshot === undefined ? undefined : liveOnSnapshot,
    onClear: props.onClear === undefined ? undefined : liveOnClear,
  };
}
