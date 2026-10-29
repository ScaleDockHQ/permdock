/**
 * Calls `refresh` when the snapshot may be out of date (a membership event, a
 * window focus, a realtime message) and returns the unsubscribe. A refresh
 * re-fetches the signed snapshot; it never grants by itself.
 */
export type RefreshTrigger = (refresh: () => void) => () => void;

export type EventSourceRefreshOptions = {
  /**
   * CloudEvent `type` values that refresh; a trailing `*` matches a prefix.
   * Defaults to `com.permdock.membership.*` and `com.permdock.catalog.*`.
   */
  readonly types?: readonly string[];
  readonly withCredentials?: boolean;
};

const DEFAULT_TYPES = ["com.permdock.membership.*", "com.permdock.catalog.*"];

const REFRESH_DELAY = 250;

function matches(type: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*")
      ? type.startsWith(pattern.slice(0, -1))
      : type === pattern,
  );
}

function eventType(data: unknown): string | undefined {
  if (typeof data !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      typeof parsed.type === "string"
    ) {
      return parsed.type;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * A `refreshOn` trigger over Server-Sent Events: each `message` whose data is a
 * structured CloudEvent with a matching `type` refreshes the snapshot. Without
 * a global `EventSource` it never fires.
 */
export function eventSourceRefresh(
  url: string,
  options: EventSourceRefreshOptions = {},
): RefreshTrigger {
  const types = options.types ?? DEFAULT_TYPES;
  return (refresh) => {
    if (typeof globalThis.EventSource !== "function") {
      return () => undefined;
    }
    const source = new globalThis.EventSource(url, {
      withCredentials: options.withCredentials === true,
    });
    source.addEventListener("message", (event) => {
      const type = eventType(event.data);
      if (type !== undefined && matches(type, types)) {
        refresh();
      }
    });
    return () => {
      source.close();
    };
  };
}

type ListenerTarget = {
  readonly addEventListener: (type: string, listener: () => void) => void;
  readonly removeEventListener: (type: string, listener: () => void) => void;
};

function isListenerTarget(value: unknown): value is ListenerTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "addEventListener") === "function" &&
    typeof Reflect.get(value, "removeEventListener") === "function"
  );
}

function listen(
  target: unknown,
  type: string,
  listener: () => void,
): () => void {
  if (!isListenerTarget(target)) {
    return () => undefined;
  }
  target.addEventListener(type, listener);
  return () => {
    target.removeEventListener(type, listener);
  };
}

/** A `refreshOn` trigger on window `focus`. Without a window it never fires. */
export function focusRefresh(): RefreshTrigger {
  return (refresh) =>
    listen(Reflect.get(globalThis, "window"), "focus", refresh);
}

/**
 * A `refreshOn` trigger on `visibilitychange` to visible, when a background tab
 * comes back. Without a `document` it never fires.
 */
export function visibilityRefresh(): RefreshTrigger {
  return (refresh) => {
    const doc: unknown = Reflect.get(globalThis, "document");
    return listen(doc, "visibilitychange", () => {
      if (
        typeof doc === "object" &&
        doc !== null &&
        Reflect.get(doc, "visibilityState") === "visible"
      ) {
        refresh();
      }
    });
  };
}

/**
 * A `refreshOn` trigger on every message to the `BroadcastChannel` `name`, so
 * one tab that learns of a change refreshes the others. Without a global
 * `BroadcastChannel` it never fires.
 */
export function broadcastChannelRefresh(name: string): RefreshTrigger {
  return (refresh) => {
    if (typeof globalThis.BroadcastChannel !== "function") {
      return () => undefined;
    }
    const channel = new globalThis.BroadcastChannel(name);
    channel.addEventListener("message", refresh);
    return () => {
      channel.close();
    };
  };
}

export type AuthzChangeRefresh = {
  /** Pass to `refreshOn`. */
  readonly trigger: RefreshTrigger;
  /** Pass to better-supabase's `<SessionProvider onAuthzChange>`. */
  readonly notify: () => void;
};

/**
 * A `refreshOn` trigger that fires on `notify()`. better-supabase's
 * `SessionProvider` already listens on the user's `authz:<uid>` topic and
 * shares changes across tabs, so `onAuthzChange={notify}` refreshes the
 * snapshot without a second Realtime channel.
 */
export function authzChangeRefresh(): AuthzChangeRefresh {
  const listeners = new Set<() => void>();
  return Object.freeze({
    trigger: (refresh: () => void) => {
      listeners.add(refresh);
      return () => {
        listeners.delete(refresh);
      };
    },
    notify: () => {
      for (const listener of listeners) {
        listener();
      }
    },
  });
}

/**
 * Runs `triggers` while `start()` holds, folding calls within 250 ms into one
 * `refresh`. `skip()` answering `true` drops a call: after `clear()` or
 * `dispose()` nothing refetches.
 */
export function refreshTriggers(
  triggers: readonly RefreshTrigger[],
  refresh: () => void,
  skip: () => boolean,
): { readonly start: () => void; readonly stop: () => void } {
  let offs: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = (): void => {
    if (skip() || timer !== undefined) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (!skip()) {
        refresh();
      }
    }, REFRESH_DELAY);
  };
  return {
    start(): void {
      if (offs.length === 0) {
        offs = triggers.map((trigger) => trigger(fire));
      }
    },
    stop(): void {
      for (const off of offs) {
        off();
      }
      offs = [];
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
