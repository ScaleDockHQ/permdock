import type { ReactElement } from "react";

import { useEffect, useMemo, useRef } from "react";

import type { ClientStore } from "../client/store.ts";
import type { ReactNativePermDockProviderProps } from "./types.ts";

import { compact } from "../core/compact.ts";
import { PermDockStoreContext, PermDockUiContext } from "../react/context.ts";
import { useKeyed } from "../react/keyed.ts";
import { useLiveOptions } from "../react/live-options.ts";
import { connectSource, nativeStore } from "./store.ts";

export function PermDockProvider(
  props: ReactNativePermDockProviderProps,
): ReactElement {
  const live = useLiveOptions(props, false);
  const shown = useRef<ClientStore | null>(null);
  const store = useKeyed(
    () =>
      nativeStore(
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
          headers: live.readHeaders,
          maxAge: props.maxAge,
          verifier: live.verifier,
          onSnapshot: live.onSnapshot,
          onClear: live.onClear,
          approvalInterval: props.approvalInterval,
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
      live.onSnapshot,
      live.onClear,
      props.approvalInterval,
    ],
  );
  const ui = useMemo(
    () => ({ defaults: props.defaults, messages: props.messages }),
    [props.defaults, props.messages],
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
        .finally(() => {
          inFlight = false;
        })
        .catch(() => undefined);
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
    <PermDockStoreContext value={store}>
      <PermDockUiContext value={ui}>{props.children}</PermDockUiContext>
    </PermDockStoreContext>
  );
}
