import type { Decision } from "../core/decision.ts";
import type { Snapshot } from "../core/interfaces.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { StoreRequest } from "./request.ts";
import type { ClientStatus } from "./types.ts";

import { rowIdOf } from "../core/row-pair.ts";
import { payloadDigest } from "../core/token.ts";

export type CacheEntry = {
  readonly decision: Decision;
  readonly status: ClientStatus;
};

export const SERVER_ONLY: Decision = {
  outcome: "denied",
  denials: [{ role: null, reason: "opaque-condition" }],
  alternatives: [],
};

/** The client has no endpoint to ask (`endpoint: false`, or none given). */
export const NO_ENDPOINT: Decision = {
  outcome: "denied",
  denials: [{ role: null, reason: "server-only" }],
  alternatives: [],
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
export function cacheKey(
  snapshot: Snapshot,
  permission: Permission,
  data: unknown,
): string {
  if (data === undefined) {
    return `${permission.key}:*`;
  }
  return `${permission.key}:${rowId(snapshot, permission, data) ?? `#${payloadDigest(data)}`}`;
}

type BatchOptions = {
  readonly endpoint: string | undefined;
  readonly request: StoreRequest;
  /** Shared with the store, which reads and invalidates the answers. */
  readonly answers: Map<string, CacheEntry>;
  readonly onServerOnly: ((permission: Permission) => void) | undefined;
  /** Bumped by the store when the snapshot, subject or tenant changes. */
  readonly generation: () => number;
  readonly snapshot: () => Snapshot;
  readonly instance: () => PermDock;
  readonly emit: () => void;
  readonly emitSoon: () => void;
};

export type Batch = {
  /** Called from render: notifies subscribers in a microtask, never inline. */
  enqueue(key: string, permission: Permission, data: unknown): void;
  clear(): void;
};

/** Collects the checks the snapshot cannot answer and posts them as one AuthZEN batch per microtask. */
export function createBatch(options: BatchOptions): Batch {
  const { answers, endpoint } = options;
  let queued: {
    readonly permission: Permission;
    readonly data: unknown;
    readonly key: string;
  }[] = [];
  let flushScheduled = false;

  const flush = async (): Promise<void> => {
    const batch = queued;
    queued = [];
    if (batch.length === 0 || endpoint === undefined) {
      return;
    }
    const started = options.generation();
    const snapshot = options.snapshot();
    if (snapshot.simulated === true) {
      for (const item of batch) {
        answers.set(item.key, { decision: SERVER_ONLY, status: "server-only" });
      }
      options.emit();
      return;
    }
    const { principal } = options.instance().subject;
    try {
      const response = await options.request(endpoint, {
        evaluations: batch.map((item) => ({
          subject: { type: principal?.kind ?? "user", id: principal?.id ?? "" },
          action: { name: item.permission.action },
          resource: {
            type: item.permission.resource,
            id: rowId(snapshot, item.permission, item.data),
            properties: item.data,
          },
        })),
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
      if (started !== options.generation()) {
        return;
      }
      for (const [index, item] of batch.entries()) {
        const row = body.evaluations?.[index];
        const decision = row?.context?.permdock ?? SERVER_ONLY;
        answers.set(item.key, { decision, status: "ready" });
      }
    } catch {
      if (started !== options.generation()) {
        return;
      }
      for (const item of batch) {
        answers.set(item.key, { decision: SERVER_ONLY, status: "server-only" });
      }
    }
    options.emit();
  };

  const scheduleFlush = (): void => {
    if (flushScheduled || endpoint === undefined) {
      return;
    }
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      void flush();
    });
  };

  return {
    enqueue(key, permission, data): void {
      if (answers.has(key)) {
        return;
      }
      if (endpoint === undefined) {
        answers.set(key, { decision: NO_ENDPOINT, status: "server-only" });
        options.onServerOnly?.(permission);
        options.emitSoon();
        return;
      }
      answers.set(key, { decision: SERVER_ONLY, status: "pending" });
      queued.push({ permission, data, key });
      options.emitSoon();
      scheduleFlush();
    },
    clear(): void {
      queued = [];
    },
  };
}
