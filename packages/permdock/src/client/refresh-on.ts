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
