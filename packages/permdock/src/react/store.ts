import type { Decision } from "../core/decision.ts";
import type { Snapshot, TokenVerifier } from "../core/interfaces.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type {
  ApprovalState,
  ClientPermDock,
  ClientStatus,
  PermissionState,
} from "./types.ts";

import { compact } from "../core/compact.ts";
import { emptySnapshot, fromSnapshot } from "../core/from-snapshot.ts";
import { rowIdOf } from "../core/row-pair.ts";
import { parseSnapshot } from "../core/snapshot.ts";
import { nowSeconds } from "../core/tenancy.ts";
import { timeoutSignal } from "../core/timeout.ts";
import { payloadDigest } from "../core/token.ts";

/** Milliseconds a decision, refresh or approval request may take; a slower one is an error like a failed request. */
const STORE_TIMEOUT_MS = 10_000;

export type ClientStoreOptions = {
  readonly snapshot: Snapshot | string;
  readonly endpoint?: string;
  readonly snapshotUrl?: string;
  readonly approvals?: string;
  readonly tenant?: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxAge?: number;
  readonly verifier?: TokenVerifier;
  readonly onSnapshot?: (
    snapshot: Snapshot,
    tenant: string | undefined,
  ) => void;
  readonly onClear?: () => void;
  /** Called once per key the snapshot cannot answer when there is no `endpoint` to ask. */
  readonly onServerOnly?: (permission: Permission) => void;
  /**
   * `true` while rendering on the server: endpoint checks answer `pending`
   * without a request. Defaults to `typeof window === 'undefined'`.
   */
  readonly server?: boolean;
  /** Milliseconds between approval status polls. Defaults to 2000. */
  readonly approvalInterval?: number;
  /** Start `pending`: the snapshot arrives later through `track()`. */
  readonly awaiting?: boolean;
};

type CacheEntry = {
  readonly decision: Decision;
  readonly status: ClientStatus;
};

/** The row's id under the snapshot's id field, or `undefined` for a row without one. */
function rowId(
  snapshot: Snapshot,
  permission: Permission,
  data: unknown,
): string | undefined {
  const id = rowIdOf(data, snapshot.ids?.[permission.resource]);
  return id === "*" ? undefined : id;
}

// A row without an id is keyed by its content, so two such rows never share an answer.
function cacheKey(
  snapshot: Snapshot,
  permission: Permission,
  data: unknown,
): string {
  if (data === undefined) {
    return `${permission.key}:*`;
  }
  return `${permission.key}:${rowId(snapshot, permission, data) ?? `#${payloadDigest(data)}`}`;
}

function withTenant(source: string, tenant: string | undefined): string {
  if (tenant === undefined) {
    return source;
  }
  const hashAt = source.indexOf("#");
  const hash = hashAt === -1 ? "" : source.slice(hashAt);
  const rest = hashAt === -1 ? source : source.slice(0, hashAt);
  const queryAt = rest.indexOf("?");
  const path = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const params = new URLSearchParams(
    queryAt === -1 ? "" : rest.slice(queryAt + 1),
  );
  params.set("tenant", tenant);
  return `${path}?${params.toString()}${hash}`;
}

function refKey(ref: Permission | { readonly [key: string]: unknown }): string {
  if ("key" in ref && typeof ref.key === "string") {
    return ref.key;
  }
  return "";
}

function isJws(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

const CURRENT = Symbol.for("permdock.current");
const STORE = Symbol("permdock.store");

const SERVER_ONLY: Decision = {
  outcome: "denied",
  denials: [{ role: null, reason: "opaque-condition" }],
  alternatives: [],
};

/** The client has no endpoint to ask (`endpoint: false`, or none given). */
const NO_ENDPOINT: Decision = {
  outcome: "denied",
  denials: [{ role: null, reason: "server-only" }],
  alternatives: [],
};

export type ClientStore = {
  get(): ClientPermDock;
  subscribe(listener: () => void): () => void;
  permissionState(permission: Permission, data?: unknown): PermissionState;
  requestApproval(decision: Decision, note?: string): Promise<void>;
  /** Hydrate from a pushed snapshot; a compact JWS goes through the verifier. */
  replace(value: unknown): void;
  /** Stay `pending` until `value` settles, then hydrate; a rejection fails closed. */
  follow(value: PromiseLike<Snapshot | string>): void;
  /**
   * `follow()` once per `value`, without suspending. A thenable React already
   * settled (`status: 'fulfilled'`) hydrates at once.
   */
  track(value: PromiseLike<Snapshot | string>): void;
  /**
   * The approval state for a decision. While something subscribes, an
   * `approval-required` decision is polled at `<approvals>/<token>`.
   */
  approvalState(decision: Decision): ApprovalState;
  /**
   * Hydrate from a resolved `snapshotPromise` during render. Idempotent per `source`;
   * subscribers are notified in a microtask, never synchronously inside render.
   */
  adopt(value: Snapshot | string, source: object): void;
  snapshot(): Snapshot;
};

/** The store that emitted `permdock`; a fresh `permdock` follows every change. */
export function storeOf(permdock: ClientPermDock): ClientStore {
  // SAFETY: hooks only pass instances from `ClientStore.get()`, which defines STORE.
  return (permdock as unknown as { readonly [STORE]: ClientStore })[STORE];
}

function needsEndpoint(decision: Decision): boolean {
  return (
    decision.outcome === "denied" &&
    decision.denials.some((denial) => denial.reason === "opaque-condition")
  );
}

export function createClientStore(options: ClientStoreOptions): ClientStore {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  // SAFETY: window is only compared with undefined, so runtimes without it read undefined.
  const server =
    options.server ??
    (globalThis as { readonly window?: unknown }).window === undefined;
  const listeners = new Set<() => void>();
  const answers = new Map<string, CacheEntry>();
  let queued: {
    readonly permission: Permission;
    readonly data: unknown;
    readonly key: string;
  }[] = [];
  let flushScheduled = false;
  let emitScheduled = false;
  let snapshot = emptySnapshot();
  let tenant = options.tenant;
  // `ready`, or why the current snapshot cannot be trusted as fresh.
  let base: "ready" | "stale" | "server-only" = "server-only";
  let instance: PermDock = fromSnapshot(snapshot, compact({ tenant }));
  let cached: ClientPermDock;
  let verifying = false;
  let refreshing = 0;
  let awaiting = options.awaiting === true;
  let following = awaiting ? 1 : 0;
  let tracked: object | undefined;
  let refreshSeq = 0;
  let silent = false;
  let adopted: object | undefined;
  // Bumped whenever the snapshot, the subject or the tenant changes; an async
  // result that started under an older generation is dropped.
  let generation = 0;

  const emit = (): void => {
    cached = wrap(instance);
    if (silent) {
      return;
    }
    for (const listener of listeners) {
      listener();
    }
  };

  const emitSoon = (): void => {
    if (emitScheduled) {
      return;
    }
    emitScheduled = true;
    queueMicrotask(() => {
      emitScheduled = false;
      emit();
    });
  };

  const reset = (): void => {
    generation += 1;
    answers.clear();
    queued = [];
  };

  const hydrate = (next: Snapshot): void => {
    reset();
    snapshot = next;
    instance = fromSnapshot(snapshot, compact({ tenant }));
    base = "ready";
    options.onSnapshot?.(next, tenant);
    emit();
  };

  const storeStatus = (): ClientStatus => {
    if (verifying || refreshing > 0 || following > 0) {
      return "pending";
    }
    if (base === "server-only") {
      return "server-only";
    }
    if (base === "stale" || isStale()) {
      return "stale";
    }
    for (const entry of answers.values()) {
      if (entry.status === "pending") {
        return "pending";
      }
    }
    return "ready";
  };

  // Reads the clock only when there is something to compare: Cache Components
  // rejects `Date.now()` in a prerendered Client Component outside Suspense.
  const isStale = (): boolean => {
    const maxAge = snapshot.issuedAt > 0 ? options.maxAge : undefined;
    if (snapshot.expiresAt === undefined && maxAge === undefined) {
      return false;
    }
    const now = nowSeconds();
    if (snapshot.expiresAt !== undefined && snapshot.expiresAt <= now) {
      return true;
    }
    return maxAge !== undefined && now - snapshot.issuedAt > maxAge;
  };

  const serverOnly = (): void => {
    hydrate(emptySnapshot());
    base = "server-only";
    emit();
  };

  const applyParsed = (value: unknown): void => {
    try {
      hydrate(parseSnapshot(value));
    } catch {
      serverOnly();
    }
  };

  // Resolves to the verified snapshot claim, or `undefined` for any failure.
  const verifyJws = async (raw: string): Promise<unknown> => {
    if (options.verifier === undefined) {
      return undefined;
    }
    try {
      const verified = await options.verifier.verify(raw, {
        typ: "permdock-snapshot+jwt",
      });
      return verified.ok ? verified.claims["snapshot"] : undefined;
    } catch {
      return undefined;
    }
  };

  const bootJws = async (raw: string): Promise<void> => {
    if (options.verifier === undefined) {
      serverOnly();
      return;
    }
    const started = generation;
    verifying = true;
    emit();
    const claim = await verifyJws(raw);
    verifying = false;
    if (started !== generation) {
      emit();
      return;
    }
    if (claim === undefined) {
      serverOnly();
      return;
    }
    applyParsed(claim);
  };

  const scheduleFlush = (): void => {
    if (flushScheduled || options.endpoint === undefined) {
      return;
    }
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      void flush();
    });
  };

  const flush = async (): Promise<void> => {
    const batch = queued;
    queued = [];
    if (batch.length === 0 || options.endpoint === undefined) {
      return;
    }
    const started = generation;
    if (snapshot.simulated === true) {
      for (const item of batch) {
        answers.set(item.key, { decision: SERVER_ONLY, status: "server-only" });
      }
      emit();
      return;
    }
    try {
      const response = await fetchImpl(options.endpoint, {
        method: "POST",
        credentials: "include",
        signal: timeoutSignal(STORE_TIMEOUT_MS),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...options.headers,
        },
        body: JSON.stringify({
          evaluations: batch.map((item) => ({
            subject: {
              type: instance.subject.principal?.kind ?? "user",
              id: instance.subject.principal?.id ?? "",
            },
            action: { name: item.permission.action },
            resource: {
              type: item.permission.resource,
              id: rowId(snapshot, item.permission, item.data),
              properties: item.data,
            },
          })),
        }),
      });
      if (!response.ok) {
        throw new Error("evaluations failed");
      }
      // SAFETY: the app's own PermDock evaluations endpoint answers in this AuthZEN shape.
      const body = (await response.json()) as {
        readonly evaluations?: readonly {
          readonly decision?: boolean;
          readonly context?: { readonly permdock?: Decision };
        }[];
      };
      if (started !== generation) {
        return;
      }
      for (const [index, item] of batch.entries()) {
        const row = body.evaluations?.[index];
        const decision = row?.context?.permdock ?? SERVER_ONLY;
        answers.set(item.key, { decision, status: "ready" });
      }
    } catch {
      if (started !== generation) {
        return;
      }
      for (const item of batch) {
        answers.set(item.key, { decision: SERVER_ONLY, status: "server-only" });
      }
    }
    emit();
  };

  // Called from render: notifies subscribers in a microtask, never inline.
  const enqueue = (
    key: string,
    permission: Permission,
    data: unknown,
  ): void => {
    if (answers.has(key)) {
      return;
    }
    if (options.endpoint === undefined) {
      answers.set(key, { decision: NO_ENDPOINT, status: "server-only" });
      options.onServerOnly?.(permission);
      emitSoon();
      return;
    }
    answers.set(key, { decision: SERVER_ONLY, status: "pending" });
    queued.push({ permission, data, key });
    emitSoon();
    scheduleFlush();
  };

  const permissionState = (
    permission: Permission,
    data?: unknown,
  ): PermissionState => {
    const key = `${tenant ?? ""}|${cacheKey(snapshot, permission, data)}`;
    const hit = answers.get(key);
    if (hit !== undefined) {
      return {
        allowed: hit.decision.outcome === "granted",
        status: hit.status,
        decision: hit.decision,
      };
    }
    // SAFETY: decide's instance and collection overloads share one implementation that takes either kind.
    const decision = (
      instance.decide as (next: Permission, row?: unknown) => Decision
    )(permission, data);
    if (needsEndpoint(decision)) {
      if (server && options.endpoint !== undefined) {
        return { allowed: false, status: "pending", decision: SERVER_ONLY };
      }
      enqueue(key, permission, data);
      const next = answers.get(key);
      if (next !== undefined) {
        return {
          allowed: false,
          status: next.status,
          decision: next.decision,
        };
      }
      return { allowed: false, status: "server-only", decision: NO_ENDPOINT };
    }
    return {
      allowed: decision.outcome === "granted",
      status:
        verifying || following > 0 ? "pending" : isStale() ? "stale" : "ready",
      decision,
    };
  };

  const approvalInterval = options.approvalInterval ?? 2000;
  const approvals = new Map<string, ApprovalState>();
  const polls = new Map<string, ReturnType<typeof setTimeout>>();
  // Tokens a render asked about that have not reached a terminal state.
  const watched = new Set<string>();
  // Bumped by `clear()`: a poll answer for the previous user is dropped.
  let approvalEpoch = 0;

  const TERMINAL: ReadonlySet<ApprovalState> = new Set([
    "approved",
    "rejected",
    "expired",
  ]);

  const stopPolls = (): void => {
    for (const timer of polls.values()) {
      clearTimeout(timer);
    }
    polls.clear();
  };

  const schedulePoll = (token: string): void => {
    if (
      server ||
      options.approvals === undefined ||
      polls.has(token) ||
      listeners.size === 0
    ) {
      return;
    }
    const epoch = approvalEpoch;
    const href = `${options.approvals.replace(/\/+$/u, "")}/${encodeURIComponent(token)}`;
    polls.set(
      token,
      setTimeout(() => {
        void (async (): Promise<void> => {
          let next: ApprovalState | undefined;
          try {
            const response = await fetchImpl(href, {
              method: "GET",
              credentials: "include",
              signal: timeoutSignal(STORE_TIMEOUT_MS),
              headers: { accept: "application/json", ...options.headers },
            });
            if (response.status === 404) {
              next = "expired";
            } else if (response.ok) {
              // SAFETY: status is only compared with the four literals; a null body throws into the catch.
              const body = (await response.json()) as {
                readonly status?: unknown;
              };
              next =
                body.status === "pending" ||
                body.status === "approved" ||
                body.status === "rejected" ||
                body.status === "expired"
                  ? body.status
                  : undefined;
            }
          } catch {
            next = undefined;
          }
          if (epoch !== approvalEpoch) {
            return;
          }
          polls.delete(token);
          if (next !== undefined && approvals.get(token) !== next) {
            approvals.set(token, next);
            emit();
          }
          if (TERMINAL.has(approvals.get(token) ?? "required")) {
            watched.delete(token);
          } else {
            schedulePoll(token);
          }
        })();
      }, approvalInterval),
    );
  };

  const approvalState = (decision: Decision): ApprovalState => {
    if (decision.outcome !== "approval-required") {
      return "not-needed";
    }
    const current = approvals.get(decision.token) ?? "required";
    if (TERMINAL.has(current)) {
      watched.delete(decision.token);
    } else {
      watched.add(decision.token);
      schedulePoll(decision.token);
    }
    return current;
  };

  // StrictMode and remounts unsubscribe every listener for a moment; polls resume
  // with the next subscriber instead of waiting for the next render.
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    if (listeners.size === 1) {
      for (const token of watched) {
        schedulePoll(token);
      }
    }
    return (): void => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        stopPolls();
      }
    };
  };

  const wrap = (permdock: PermDock): ClientPermDock => {
    const client: ClientPermDock = {
      ...permdock,
      status(permission?: Permission, data?: unknown): ClientStatus {
        if (permission === undefined) {
          return storeStatus();
        }
        return permissionState(permission, data).status;
      },
      invalidate(ref: Permission | { readonly [key: string]: unknown }): void {
        const prefix = refKey(ref);
        for (const key of answers.keys()) {
          const unscoped = key.slice(key.indexOf("|") + 1);
          if (
            prefix === "" ||
            unscoped === prefix ||
            unscoped.startsWith(`${prefix}:`) ||
            unscoped.startsWith(`${prefix}.`)
          ) {
            answers.delete(key);
          }
        }
        base = "stale";
        emit();
      },
      async refresh(query?: { readonly tenant?: string }): Promise<void> {
        const requested = query?.tenant;
        const source = options.snapshotUrl ?? options.endpoint;
        if (
          requested !== undefined &&
          (snapshot.tenants.includes(requested) || source === undefined)
        ) {
          tenant = requested;
          hydrate(snapshot);
          return;
        }
        if (source === undefined) {
          return;
        }
        const started = generation;
        refreshSeq += 1;
        const seq = refreshSeq;
        refreshing += 1;
        emit();
        let body: unknown;
        let ok = false;
        try {
          const response = await fetchImpl(withTenant(source, requested), {
            method: "GET",
            credentials: "include",
            signal: timeoutSignal(STORE_TIMEOUT_MS),
            headers: {
              accept: "application/json",
              ...options.headers,
            },
          });
          if (response.ok) {
            body = await response.json();
            ok = true;
          }
        } catch {
          ok = false;
        }
        if (ok && typeof body === "string" && isJws(body)) {
          body = await verifyJws(body);
          ok = body !== undefined;
        }
        refreshing -= 1;
        if (started !== generation || seq !== refreshSeq) {
          emit();
          return;
        }
        let next: Snapshot | undefined;
        try {
          next = ok ? parseSnapshot(body) : undefined;
        } catch {
          next = undefined;
        }
        if (next === undefined) {
          base = "stale";
          emit();
          return;
        }
        if (requested !== undefined) {
          tenant = requested;
        }
        hydrate(next);
      },
      clear(): void {
        reset();
        tenant = options.tenant;
        snapshot = emptySnapshot();
        instance = fromSnapshot(snapshot, compact({ tenant }));
        base = "server-only";
        approvalEpoch += 1;
        stopPolls();
        approvals.clear();
        watched.clear();
        options.onClear?.();
        emit();
      },
      subscribe,
    };
    // Long-lived consumers (WebMCP) hold one object; this reaches the latest.
    Object.defineProperty(client, CURRENT, { value: () => cached });
    Object.defineProperty(client, STORE, { value: store });
    return client;
  };

  const land = (next: unknown): void => {
    if (next === undefined) {
      serverOnly();
    } else if (typeof next === "string" && isJws(next)) {
      void bootJws(next);
    } else {
      applyParsed(next);
    }
  };

  const follow = (value: PromiseLike<Snapshot | string>): void => {
    const started = generation;
    following += 1;
    emit();
    const settle = (next: Snapshot | string | undefined): void => {
      following -= 1;
      if (started !== generation) {
        emit();
        return;
      }
      land(next);
    };
    Promise.resolve(value).then(settle, () => {
      settle(undefined);
    });
  };

  const boot = (value: Snapshot | string): void => {
    if (typeof value === "string" && isJws(value)) {
      cached = wrap(instance);
      void bootJws(value);
    } else {
      applyParsed(value);
      cached = wrap(instance);
    }
  };

  const store: ClientStore = {
    get(): ClientPermDock {
      return cached;
    },
    subscribe,
    permissionState,
    approvalState,
    replace(value: unknown): void {
      if (typeof value === "string" && isJws(value)) {
        void bootJws(value);
        return;
      }
      applyParsed(value);
    },
    follow,
    track(value: PromiseLike<Snapshot | string>): void {
      if (tracked === value) {
        return;
      }
      tracked = value;
      if (awaiting) {
        awaiting = false;
        following -= 1;
      }
      // SAFETY: React marks a thenable it has read with `status` and `value`; anything else is pending.
      const thenable = value as {
        readonly status?: unknown;
        readonly value?: unknown;
      };
      if (thenable.status === "fulfilled") {
        land(thenable.value);
      } else if (thenable.status === "rejected") {
        serverOnly();
      } else {
        follow(value);
      }
    },
    adopt(value: Snapshot | string, source: object): void {
      if (adopted === source) {
        return;
      }
      adopted = source;
      reset();
      silent = true;
      try {
        boot(value);
      } finally {
        silent = false;
      }
      queueMicrotask(emit);
    },
    snapshot(): Snapshot {
      return snapshot;
    },
    async requestApproval(decision: Decision, note?: string): Promise<void> {
      if (
        decision.outcome !== "approval-required" ||
        snapshot.simulated === true
      ) {
        return;
      }
      const href = options.approvals ?? options.endpoint;
      if (href === undefined) {
        return;
      }
      const response = await fetchImpl(href, {
        method: "POST",
        credentials: "include",
        signal: timeoutSignal(STORE_TIMEOUT_MS),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...options.headers,
        },
        body: JSON.stringify({
          permission: decision.grant.permission,
          token: decision.token,
          note,
        }),
      });
      if (
        response.ok &&
        !TERMINAL.has(approvals.get(decision.token) ?? "required")
      ) {
        approvals.set(decision.token, "pending");
        emit();
      }
    },
  };
  boot(options.snapshot);
  return store;
}
