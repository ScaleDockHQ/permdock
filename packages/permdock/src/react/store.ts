import type { Decision } from '../core/decision.ts';
import type { Snapshot, TokenVerifier } from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { ClientPermDock, ClientStatus, PermissionState } from './types.ts';

import { compact } from '../core/compact.ts';
import { emptySnapshot, fromSnapshot } from '../core/from-snapshot.ts';
import { parseSnapshot } from '../core/snapshot.ts';
import { nowSeconds } from '../core/tenancy.ts';

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
};

type CacheEntry = {
  readonly decision: Decision;
  readonly status: ClientStatus;
};

function cacheKey(permission: Permission, data: unknown): string {
  if (data === null || typeof data !== 'object') {
    return `${permission.key}:*`;
  }
  const id = (data as Record<string, unknown>).id;
  return `${permission.key}:${typeof id === 'string' || typeof id === 'number' ? String(id) : '*'}`;
}

function refKey(ref: Permission | { readonly [key: string]: unknown }): string {
  if ('key' in ref && typeof ref.key === 'string') {
    return ref.key;
  }
  return '';
}

function isJws(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

const SERVER_ONLY: Decision = {
  outcome: 'denied',
  denials: [{ role: null, reason: 'opaque-condition' }],
  alternatives: [],
};

export type ClientStore = {
  get(): ClientPermDock;
  subscribe(listener: () => void): () => void;
  permissionState(permission: Permission, data?: unknown): PermissionState;
  requestApproval(decision: Decision, note?: string): Promise<void>;
  replace(value: unknown): void;
  snapshot(): Snapshot;
};

function needsEndpoint(decision: Decision): boolean {
  return (
    decision.outcome === 'denied' &&
    decision.denials.some((denial) => denial.reason === 'opaque-condition')
  );
}

export function createClientStore(options: ClientStoreOptions): ClientStore {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const listeners = new Set<() => void>();
  const answers = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<Decision>>();
  let queued: {
    readonly permission: Permission;
    readonly data: unknown;
    readonly key: string;
  }[] = [];
  let flushScheduled = false;
  let snapshot = emptySnapshot();
  let tenant = options.tenant;
  let storeStatus: ClientStatus = 'server-only';
  let instance: PermDock = fromSnapshot(snapshot, compact({ tenant }));
  let cached: ClientPermDock;
  let verifying = false;

  const emit = (): void => {
    cached = wrap(instance);
    for (const listener of listeners) {
      listener();
    }
  };

  const hydrate = (next: Snapshot): void => {
    snapshot = next;
    instance = fromSnapshot(snapshot, compact({ tenant }));
    storeStatus = isStale() ? 'stale' : 'ready';
    options.onSnapshot?.(next, tenant);
    emit();
  };

  const isStale = (): boolean => {
    const now = nowSeconds();
    if (snapshot.expiresAt !== undefined && snapshot.expiresAt <= now) {
      return true;
    }
    if (
      options.maxAge !== undefined &&
      snapshot.issuedAt > 0 &&
      now - snapshot.issuedAt > options.maxAge
    ) {
      return true;
    }
    return false;
  };

  const applyParsed = (value: unknown): void => {
    try {
      hydrate(parseSnapshot(value));
    } catch {
      hydrate(emptySnapshot());
      storeStatus = 'server-only';
      emit();
    }
  };

  const bootJws = async (raw: string): Promise<void> => {
    if (options.verifier === undefined) {
      hydrate(emptySnapshot());
      storeStatus = 'server-only';
      emit();
      return;
    }
    verifying = true;
    storeStatus = 'pending';
    emit();
    const verified = await options.verifier.verify(raw, {
      typ: 'permdock-snapshot+jwt',
    });
    verifying = false;
    if (!verified.ok) {
      hydrate(emptySnapshot());
      storeStatus = 'server-only';
      emit();
      return;
    }
    applyParsed(verified.claims.snapshot);
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
    if (snapshot.simulated === true) {
      for (const item of batch) {
        answers.set(item.key, { decision: SERVER_ONLY, status: 'server-only' });
      }
      emit();
      return;
    }
    try {
      const response = await fetchImpl(options.endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...options.headers,
        },
        body: JSON.stringify({
          evaluations: batch.map((item) => ({
            subject: {
              type: instance.subject.principal?.kind ?? 'user',
              id: instance.subject.principal?.id ?? '',
            },
            action: { name: item.permission.action },
            resource: {
              type: item.permission.resource,
              id:
                item.data !== null &&
                typeof item.data === 'object' &&
                'id' in item.data
                  ? String((item.data as { readonly id?: unknown }).id ?? '')
                  : undefined,
              properties: item.data,
            },
          })),
        }),
      });
      if (!response.ok) {
        throw new Error('evaluations failed');
      }
      const body = (await response.json()) as {
        readonly evaluations?: readonly {
          readonly decision?: boolean;
          readonly context?: { readonly permdock?: Decision };
        }[];
      };
      for (const [index, item] of batch.entries()) {
        const row = body.evaluations?.[index];
        const decision = row?.context?.permdock ?? SERVER_ONLY;
        answers.set(item.key, { decision, status: 'ready' });
        inflight.delete(item.key);
      }
    } catch {
      for (const item of batch) {
        answers.set(item.key, { decision: SERVER_ONLY, status: 'server-only' });
        inflight.delete(item.key);
      }
    }
    emit();
  };

  const enqueue = (permission: Permission, data: unknown): void => {
    const key = cacheKey(permission, data);
    if (answers.has(key) || inflight.has(key)) {
      return;
    }
    if (options.endpoint === undefined) {
      answers.set(key, { decision: SERVER_ONLY, status: 'server-only' });
      emit();
      return;
    }
    answers.set(key, { decision: SERVER_ONLY, status: 'pending' });
    inflight.set(key, Promise.resolve(SERVER_ONLY));
    queued.push({ permission, data, key });
    storeStatus = 'pending';
    emit();
    scheduleFlush();
  };

  const permissionState = (
    permission: Permission,
    data?: unknown,
  ): PermissionState => {
    const key = cacheKey(permission, data);
    const hit = answers.get(key);
    if (hit !== undefined) {
      return {
        allowed: hit.decision.outcome === 'granted',
        status: hit.status,
        decision: hit.decision,
      };
    }
    const decision = (
      instance.decide as (next: Permission, row?: unknown) => Decision
    )(permission, data);
    if (needsEndpoint(decision)) {
      enqueue(permission, data);
      const next = answers.get(key);
      if (next !== undefined) {
        return {
          allowed: false,
          status: next.status,
          decision: next.decision,
        };
      }
      return { allowed: false, status: 'server-only', decision: SERVER_ONLY };
    }
    return {
      allowed: decision.outcome === 'granted',
      status: isStale() ? 'stale' : verifying ? 'pending' : 'ready',
      decision,
    };
  };

  const wrap = (dock: PermDock): ClientPermDock => {
    const client: ClientPermDock = {
      ...dock,
      status(permission?: Permission, data?: unknown): ClientStatus {
        if (permission === undefined) {
          return storeStatus;
        }
        return permissionState(permission, data).status;
      },
      invalidate(ref: Permission | { readonly [key: string]: unknown }): void {
        const prefix = refKey(ref);
        for (const key of answers.keys()) {
          if (
            prefix === '' ||
            key === prefix ||
            key.startsWith(`${prefix}:`) ||
            key.startsWith(`${prefix}.`)
          ) {
            answers.delete(key);
          }
        }
        storeStatus = 'stale';
        emit();
      },
      async refresh(query?: { readonly tenant?: string }): Promise<void> {
        if (query?.tenant !== undefined) {
          tenant = query.tenant;
          if (
            snapshot.tenants.includes(query.tenant) ||
            (options.snapshotUrl === undefined &&
              options.endpoint === undefined)
          ) {
            instance = fromSnapshot(snapshot, compact({ tenant }));
            storeStatus = 'ready';
            options.onSnapshot?.(snapshot, tenant);
            emit();
            return;
          }
        }
        const source = options.snapshotUrl ?? options.endpoint;
        if (source === undefined) {
          return;
        }
        storeStatus = 'stale';
        emit();
        try {
          const href = new URL(source, 'https://permdock.local');
          if (query?.tenant !== undefined) {
            href.searchParams.set('tenant', query.tenant);
          }
          const response = await fetchImpl(`${source}${href.search}`, {
            method: 'GET',
            credentials: 'include',
            headers: {
              accept: 'application/json',
              ...options.headers,
            },
          });
          if (!response.ok) {
            throw new Error('refresh failed');
          }
          applyParsed(await response.json());
        } catch {
          storeStatus = 'stale';
          emit();
        }
      },
      clear(): void {
        answers.clear();
        inflight.clear();
        queued = [];
        tenant = options.tenant;
        snapshot = emptySnapshot();
        instance = fromSnapshot(snapshot, compact({ tenant }));
        storeStatus = 'server-only';
        options.onClear?.();
        emit();
      },
      subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
    };
    return client;
  };

  if (typeof options.snapshot === 'string' && isJws(options.snapshot)) {
    cached = wrap(instance);
    void bootJws(options.snapshot);
  } else {
    applyParsed(options.snapshot);
    cached = wrap(instance);
  }

  return {
    get(): ClientPermDock {
      return cached;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    permissionState,
    replace(value: unknown): void {
      applyParsed(value);
    },
    snapshot(): Snapshot {
      return snapshot;
    },
    async requestApproval(decision: Decision, note?: string): Promise<void> {
      if (
        decision.outcome !== 'approval-required' ||
        snapshot.simulated === true
      ) {
        return;
      }
      const href = options.approvals ?? options.endpoint;
      if (href === undefined) {
        return;
      }
      await fetchImpl(href, {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...options.headers,
        },
        body: JSON.stringify({
          permission: decision.grant.permission,
          token: decision.token,
          note,
        }),
      });
    },
  };
}
