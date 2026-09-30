import type { Decision } from '../core/decision.ts';
import type { RevokedCode } from '../core/errors.ts';
import type { DecideOptions, PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { RevocationEvent, RevocationFeed } from '../core/revocations.ts';

import { compact } from '../core/compact.ts';
import { PermDockRevokedError } from '../core/errors.ts';

/** `setTimeout` stores delays in a signed 32-bit integer. */
const MAX_DELAY = 2_147_483_647;

export type ConnectionData<T> =
  | T
  | (() => T | null | undefined | Promise<T | null | undefined>);

export type ConnectionOptions<T = unknown> = {
  /** The permission the stream or socket is opened for; re-checked after every revalidation. */
  readonly permission?: Permission;
  /** The row for `permission`, or a loader re-run on every revalidation. */
  readonly data?: ConnectionData<T>;
  /** Milliseconds between periodic revalidations; off by default. */
  readonly revalidate?: number;
};

export type Connection = {
  /** The current instance; replaced, never mutated, after a revalidation. */
  readonly permdock: PermDock;
  /** Aborts with a `PermDockRevokedError` when the connection must end. */
  readonly signal: AbortSignal;
  /**
   * Per-message decision. Pass `{ trusted: false }` for data from the message
   * itself: it is validated against the resource schema first.
   */
  readonly check: (
    permission: Permission,
    data?: unknown,
    options?: { readonly trusted?: boolean },
  ) => Decision;
  readonly filter: <T>(
    permission: Permission<string, T, 'instance'>,
    items: readonly T[],
  ) => T[];
  /** Stops timers and the feed subscription. Call it when the transport closes. */
  readonly close: () => void;
};

type OpenInput<T> = {
  /** The instance from the opening request. */
  readonly open: () => Promise<PermDock>;
  /** A fresh instance: subject, memberships and roles resolved again. */
  readonly rebuild: () => Promise<PermDock>;
  readonly tenant: string | undefined;
  readonly feed?: RevocationFeed;
  readonly adapter: string;
  readonly options: ConnectionOptions<T>;
};

const REVOKED: Decision = Object.freeze({
  outcome: 'denied',
  denials: Object.freeze([
    Object.freeze({
      role: null,
      reason: 'no-grant' as const,
      detail: 'connection-revoked',
    }),
  ]),
  alternatives: Object.freeze([]),
});

function principalId(dock: PermDock): string | undefined {
  return dock.subject.principal?.id;
}

function nextMembershipExpiry(dock: PermDock, now: number): number | undefined {
  let next: number | undefined;
  for (const membership of dock.memberships()) {
    const at = membership.expiresAt;
    if (at !== undefined && at > now && (next === undefined || at < next)) {
      next = at;
    }
  }
  return next;
}

async function loadData<T>(
  data: ConnectionData<T> | undefined,
): Promise<{ readonly ok: boolean; readonly value: T | undefined }> {
  if (data === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof data !== 'function') {
    return { ok: true, value: data };
  }
  // SAFETY: data is a value or a loader, and the value case returned above.
  const loaded = await (
    data as () => T | null | undefined | Promise<T | null | undefined>
  )();
  return loaded === null || loaded === undefined
    ? { ok: false, value: undefined }
    : { ok: true, value: loaded };
}

function matches(
  event: RevocationEvent,
  dock: PermDock,
  tenant: string | undefined,
): boolean {
  if (event.principal !== principalId(dock)) {
    return false;
  }
  const session = dock.subject.session;
  if (
    event.session !== undefined &&
    session !== undefined &&
    event.session !== session
  ) {
    return false;
  }
  return !(
    event.kind === 'changed' &&
    event.tenant !== undefined &&
    tenant !== undefined &&
    event.tenant !== tenant
  );
}

/** Opens a long-lived connection. Never throws; a failure aborts. */
export async function openConnection<T>(
  input: OpenInput<T>,
): Promise<Connection> {
  const controller = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const decideOptions = compact<DecideOptions>({
    source: 'adapter',
    adapter: input.adapter,
  });
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  let current: PermDock | undefined;
  let chain: Promise<void> = Promise.resolve();

  const clear = (): void => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
    unsubscribe?.();
    unsubscribe = undefined;
  };

  const abort = (
    code: RevokedCode,
    decision?: Exclude<Decision, { readonly outcome: 'granted' }>,
  ): void => {
    if (controller.signal.aborted) {
      return;
    }
    clear();
    controller.abort(
      new PermDockRevokedError(
        compact({ code, permission: input.options.permission?.key, decision }),
      ),
    );
  };

  const after = (ms: number, run: () => void): void => {
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        run();
      },
      Math.max(0, Math.min(ms, MAX_DELAY)),
    );
    timers.add(timer);
  };

  /** `true` when `dock` still holds the opening permission. */
  const admits = async (dock: PermDock): Promise<boolean> => {
    const { permission } = input.options;
    if (permission === undefined) {
      return true;
    }
    const loaded = await loadData(input.options.data);
    if (!loaded.ok) {
      abort('denied');
      return false;
    }
    // SAFETY: decide's generics only tie the row type to the permission; it accepts any row.
    const decision = (
      dock.decide as (
        next: Permission,
        row?: unknown,
        options?: DecideOptions,
      ) => Decision
    )(permission, loaded.value, decideOptions);
    if (decision.outcome !== 'granted') {
      abort('denied', decision);
      return false;
    }
    return true;
  };

  let schedule: ((dock: PermDock) => void) | undefined;

  const revalidate = (): void => {
    chain = chain
      .then(async () => {
        if (controller.signal.aborted || closed) {
          return;
        }
        let next: PermDock;
        try {
          next = await input.rebuild();
        } catch {
          abort('subject-changed');
          return;
        }
        const id = principalId(next);
        if (
          id === undefined ||
          current === undefined ||
          id !== principalId(current)
        ) {
          abort('subject-changed');
          return;
        }
        if (!(await admits(next))) {
          return;
        }
        current = next;
        for (const timer of timers) {
          clearTimeout(timer);
        }
        timers.clear();
        schedule?.(next);
      })
      .catch(() => {
        abort('subject-changed');
      });
  };

  schedule = (dock: PermDock): void => {
    const now = Date.now() / 1000;
    const expiresAt = dock.subject.expiresAt;
    if (expiresAt !== undefined) {
      if (expiresAt <= now) {
        abort('expired');
        return;
      }
      const wait = (expiresAt - now) * 1000;
      after(wait, () => {
        if (wait > MAX_DELAY) {
          schedule?.(current ?? dock);
          return;
        }
        abort('expired');
      });
    }
    const membership = nextMembershipExpiry(dock, now);
    if (membership !== undefined) {
      after((membership - now) * 1000, revalidate);
    }
    const every = input.options.revalidate;
    if (every !== undefined && Number.isFinite(every) && every > 0) {
      after(every, revalidate);
    }
  };

  try {
    current = await input.open();
  } catch {
    abort('denied');
  }
  if (
    current !== undefined &&
    !controller.signal.aborted &&
    (await admits(current))
  ) {
    schedule(current);
    if (input.feed !== undefined && !controller.signal.aborted) {
      try {
        unsubscribe = input.feed.subscribe((event) => {
          if (current === undefined || !matches(event, current, input.tenant)) {
            return;
          }
          if (event.kind === 'session-revoked') {
            abort('session-revoked');
          } else {
            revalidate();
          }
        });
      } catch {
        abort('expired');
      }
    }
  }

  const live = (): PermDock | undefined =>
    controller.signal.aborted || closed ? undefined : current;

  return Object.freeze({
    get permdock(): PermDock {
      if (current === undefined) {
        throw new PermDockRevokedError({ code: 'denied' });
      }
      return current;
    },
    signal: controller.signal,
    check(
      permission: Permission,
      data?: unknown,
      checkOptions?: { readonly trusted?: boolean },
    ): Decision {
      const dock = live();
      if (dock === undefined) {
        return REVOKED;
      }
      // SAFETY: decide's generics only tie the row type to the permission; it accepts any row.
      return (
        dock.decide as (
          next: Permission,
          row?: unknown,
          options?: DecideOptions,
        ) => Decision
      )(
        permission,
        data,
        checkOptions?.trusted === false
          ? { ...decideOptions, trusted: false, boundary: 'manual' }
          : decideOptions,
      );
    },
    filter<U>(
      permission: Permission<string, U, 'instance'>,
      items: readonly U[],
    ): U[] {
      const dock = live();
      return dock === undefined
        ? []
        : dock.filter(permission, items, decideOptions);
    },
    close(): void {
      closed = true;
      clear();
    },
  });
}
