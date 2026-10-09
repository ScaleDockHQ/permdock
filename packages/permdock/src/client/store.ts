import type { Decision } from "../core/decision.ts";
import type { Snapshot, TokenVerifier } from "../core/interfaces.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { CacheEntry } from "./batch.ts";
import type { StoreHeaders } from "./request.ts";
import type {
  ApprovalState,
  ClientPermDock,
  ClientStatus,
  PermissionState,
} from "./types.ts";

import { compact } from "../core/compact.ts";
import { emptySnapshot, fromSnapshot } from "../core/from-snapshot.ts";
import { parseSnapshot } from "../core/snapshot.ts";
import { nowSeconds } from "../core/tenancy.ts";
import { createApprovals } from "./approvals.ts";
import { NO_ENDPOINT, SERVER_ONLY, cacheKey, createBatch } from "./batch.ts";
import { storeRequest } from "./request.ts";
import { isJws } from "./source.ts";

export type ClientStoreOptions = {
  readonly snapshot: Snapshot | string;
  readonly endpoint?: string;
  readonly snapshotUrl?: string;
  readonly approvals?: string;
  readonly tenant?: string;
  readonly fetch?: typeof fetch;
  /** Request headers, or a getter read on every request so a rotated token needs no new store. */
  readonly headers?: StoreHeaders | (() => StoreHeaders | undefined);
  readonly maxAge?: number;
  readonly verifier?: TokenVerifier;
  /** `raw` is the compact JWS the snapshot was verified from, so a signed snapshot can be persisted signed. */
  readonly onSnapshot?: (
    snapshot: Snapshot,
    tenant: string | undefined,
    raw: string | undefined,
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
  /**
   * The first snapshot that hydrates with a principal is a persisted copy:
   * `stale` until a refresh or a `replace()` lands.
   */
  readonly stale?: boolean;
  /**
   * Reuse decisions for the same row object until the next microtask. Only for
   * renderers that do not track the fields a check reads (React): Vue, Svelte
   * and Solid would stop re-running when a reactive row changes in place.
   */
  readonly passCache?: boolean;
};

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

const CURRENT = Symbol.for("permdock.current");
const STORE = Symbol("permdock.store");

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
  /** The tenant the store currently answers for. */
  tenant(): string | undefined;
  /** Stops polls, drops in-flight results and persistence; the store keeps answering from its last snapshot. */
  dispose(): void;
};

const VALIDATION: Decision = {
  outcome: "denied",
  denials: [{ role: null, reason: "validation" }],
  alternatives: [],
};

function report(error: unknown): void {
  // SAFETY: reportError is only called when the runtime defines it as a function.
  const reporter = (globalThis as { readonly reportError?: unknown })
    .reportError as ((error: unknown) => void) | undefined;
  if (typeof reporter === "function") {
    reporter(error);
    return;
  }
  // oxlint-disable-next-line no-console -- a subscriber threw and the runtime has no reportError
  console.error(error);
}

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
  let disposed = false;
  let staleNext = options.stale === true;
  // The compact JWS the snapshot being hydrated was verified from.
  let rawJws: string | undefined;

  const request = storeRequest(fetchImpl, (): StoreHeaders | undefined =>
    typeof options.headers === "function" ? options.headers() : options.headers,
  );

  // A throwing subscriber must not keep the others on a revoked answer.
  const emit = (): void => {
    cached = wrap(instance);
    if (silent) {
      return;
    }
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        report(error);
      }
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

  const batch = createBatch({
    endpoint: options.endpoint,
    request,
    answers,
    onServerOnly: options.onServerOnly,
    generation: () => generation,
    snapshot: () => snapshot,
    instance: () => instance,
    emit,
    emitSoon,
  });

  const approvals = createApprovals({
    approvals: options.approvals,
    endpoint: options.endpoint,
    interval: options.approvalInterval ?? 2000,
    server,
    request,
    emit,
    disposed: () => disposed,
    listening: () => listeners.size > 0,
    simulated: () => snapshot.simulated === true,
  });

  const reset = (): void => {
    generation += 1;
    answers.clear();
    decided.clear();
    batch.clear();
  };

  const hydrate = (next: Snapshot): void => {
    reset();
    if (
      (snapshot.subject.principal?.id ?? null) !==
      (next.subject.principal?.id ?? null)
    ) {
      approvals.forget();
    }
    snapshot = next;
    instance = fromSnapshot(snapshot, compact({ tenant }));
    base = "ready";
    if (staleNext && next.subject.principal !== null) {
      staleNext = false;
      base = "stale";
    }
    const raw = rawJws;
    rawJws = undefined;
    if (!disposed) {
      options.onSnapshot?.(next, tenant, raw);
    }
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
    rawJws = raw;
    applyParsed(claim);
  };

  // With `passCache`, one render pass that checks the same row object from many
  // components evaluates it once. The decisions live until the next microtask:
  // a row mutated in place and checked again in the same task reads the earlier
  // answer, which is why fine-grained renderers leave the cache off.
  const decided = new Map<unknown, Map<string, Decision>>();
  let decidedClear = false;

  const evaluate = (permission: Permission, data: unknown): Decision => {
    try {
      // SAFETY: decide's instance and collection overloads share one implementation that takes either kind.
      return (instance.decide as (next: Permission, row?: unknown) => Decision)(
        permission,
        data,
      );
    } catch {
      return VALIDATION;
    }
  };

  const decideLocal = (permission: Permission, data: unknown): Decision => {
    if (options.passCache !== true) {
      return evaluate(permission, data);
    }
    let byKey = decided.get(data);
    const hit = byKey?.get(permission.key);
    if (hit !== undefined) {
      return hit;
    }
    const decision = evaluate(permission, data);
    if (byKey === undefined) {
      byKey = new Map();
      decided.set(data, byKey);
    }
    byKey.set(permission.key, decision);
    if (!decidedClear) {
      decidedClear = true;
      queueMicrotask(() => {
        decidedClear = false;
        decided.clear();
      });
    }
    return decision;
  };

  const permissionState = (
    permission: Permission,
    data?: unknown,
  ): PermissionState => {
    const decision = decideLocal(permission, data);
    if (decision === VALIDATION) {
      return { allowed: false, status: "ready", decision };
    }
    if (needsEndpoint(decision)) {
      let rowKey: string;
      try {
        rowKey = cacheKey(snapshot, permission, data);
      } catch {
        return { allowed: false, status: "ready", decision: VALIDATION };
      }
      const key = `${tenant ?? ""}|${rowKey}`;
      const hit = answers.get(key);
      if (hit !== undefined) {
        return {
          allowed: hit.decision.outcome === "granted",
          status: hit.status,
          decision: hit.decision,
        };
      }
      if (server && options.endpoint !== undefined) {
        return { allowed: false, status: "pending", decision: SERVER_ONLY };
      }
      batch.enqueue(key, permission, data);
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
        verifying || following > 0
          ? "pending"
          : base === "stale" || isStale()
            ? "stale"
            : "ready",
      decision,
    };
  };

  // StrictMode and remounts unsubscribe every listener for a moment; polls resume
  // with the next subscriber instead of waiting for the next render.
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    if (listeners.size === 1) {
      approvals.resume();
    }
    return (): void => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        approvals.stop();
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
          const wasStale = base === "stale";
          tenant = requested;
          hydrate(snapshot);
          if (wasStale) {
            base = "stale";
            emit();
          }
          return;
        }
        if (source === undefined || disposed) {
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
          const response = await request(withTenant(source, requested));
          if (response.ok) {
            body = await response.json();
            ok = true;
          }
        } catch {
          ok = false;
        }
        let signed: string | undefined;
        if (ok && typeof body === "string" && isJws(body)) {
          signed = body;
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
        staleNext = false;
        rawJws = signed;
        hydrate(next);
      },
      clear(): void {
        reset();
        tenant = options.tenant;
        snapshot = emptySnapshot();
        instance = fromSnapshot(snapshot, compact({ tenant }));
        base = "server-only";
        approvals.forget();
        if (!disposed) {
          options.onClear?.();
        }
        emit();
      },
      subscribe,
    };
    // Long-lived consumers (WebMCP) hold one object; this reaches the latest.
    Object.defineProperty(client, CURRENT, { value: () => cached });
    Object.defineProperty(client, STORE, { value: store });
    return client;
  };

  // A compact JWS goes through the verifier; anything else is parsed as a snapshot.
  const dispatch = (value: unknown): void => {
    if (typeof value === "string" && isJws(value)) {
      void bootJws(value);
    } else {
      applyParsed(value);
    }
  };

  const land = (next: unknown): void => {
    if (next === undefined) {
      serverOnly();
    } else {
      dispatch(next);
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

  const store: ClientStore = {
    get(): ClientPermDock {
      return cached;
    },
    subscribe,
    permissionState,
    approvalState: approvals.state,
    replace(value: unknown): void {
      staleNext = false;
      dispatch(value);
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
        dispatch(value);
      } finally {
        silent = false;
      }
      queueMicrotask(emit);
    },
    snapshot(): Snapshot {
      return snapshot;
    },
    tenant(): string | undefined {
      return tenant;
    },
    dispose(): void {
      disposed = true;
      generation += 1;
      batch.clear();
      approvals.forget();
      listeners.clear();
    },
    requestApproval: approvals.request,
  };
  dispatch(options.snapshot);
  return store;
}
