import {
  type ReactElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { ClientStore } from "../client/store.ts";
import type { NativePermDockProviderProps } from "./types.ts";

import { compact } from "../core/compact.ts";
import { PermDockStoreContext } from "../react/context.ts";
import { useKeyed } from "../react/keyed.ts";
import { useLiveOptions } from "../react/live-options.ts";
import { connectSource, createNativeStore } from "./store.ts";

export function PermDockProvider(
  props: NativePermDockProviderProps,
): ReactElement {
  const live = useLiveOptions(props);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const [headers] = useState(
    () => (): Readonly<Record<string, string>> | undefined =>
      latest.current.headers,
  );
  const shown = useRef<ClientStore | null>(null);
  const store = useKeyed(
    () =>
      createNativeStore(
        compact({
          storage: props.storage,
          subjectId: props.subjectId,
          snapshot: props.snapshot,
          snapshotUrl: props.snapshotUrl,
          source: props.source,
          endpoint: props.endpoint,
          approvals: props.approvals,
          tenant: props.tenant,
          fetch: live.fetch,
          headers,
          maxAge: props.maxAge,
          verifier: live.verifier,
          previous: shown.current ?? undefined,
        }),
      ),
    [
      props.storage,
      props.subjectId,
      props.snapshot,
      props.snapshotUrl,
      props.source,
      props.endpoint,
      props.approvals,
      props.tenant,
      live.fetch,
      props.maxAge,
      live.verifier,
    ],
  );

  // The replaced store stops writing once this one is on screen; disposing
  // during render would kill a store a discarded render never replaced.
  useEffect(() => {
    const previous = shown.current;
    shown.current = store;
    if (previous !== null && previous !== store) {
      previous.dispose();
    }
  }, [store]);

  useEffect(
    () =>
      props.source === undefined
        ? undefined
        : connectSource(store, props.source, props.subscribeForeground),
    [store, props.source, props.subscribeForeground],
  );

  useEffect(() => {
    if (props.snapshotUrl === undefined) {
      return undefined;
    }
    const mode = props.revalidate ?? "launch";
    let inFlight = false;
    let online = true;
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = (): void => {
      if (inFlight || !online) {
        return;
      }
      inFlight = true;
      store
        .get()
        .refresh()
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };
    const startTimer = (): void => {
      if (typeof mode === "number" && timer === undefined) {
        timer = setInterval(refresh, mode * 1000);
      }
    };
    const stopTimer = (): void => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    refresh();
    startTimer();
    const offForeground = props.subscribeForeground?.((next) => {
      const now = next !== false;
      if (now === active) {
        if (now && mode === "focus") {
          refresh();
        }
        return;
      }
      active = now;
      if (!active) {
        stopTimer();
        return;
      }
      startTimer();
      if (mode === "focus" || typeof mode === "number") {
        refresh();
      }
    });
    const offOnline = props.subscribeOnline?.((next) => {
      const back = next && !online;
      online = next;
      if (back && active) {
        refresh();
      }
    });
    return (): void => {
      stopTimer();
      offForeground?.();
      offOnline?.();
    };
  }, [
    store,
    props.revalidate,
    props.snapshotUrl,
    props.subscribeForeground,
    props.subscribeOnline,
  ]);

  return (
    <PermDockStoreContext value={store}>{props.children}</PermDockStoreContext>
  );
}
