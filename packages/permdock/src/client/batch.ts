import type { Decision } from "../core/decision.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Snapshot } from "../core/snapshot-types.ts";
import type { Subject } from "../core/subject.ts";
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

/**
 * The row's id under the snapshot's id field, or `undefined` for a row without
 * one.
 */
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

/** Evaluations in one request. */
export const MAX_BATCH_ITEMS: number = 256;
/** Serialised bytes in one request, below the usual 1 MiB body limit. */
export const MAX_BATCH_BYTES: number = 1024 * 1024;
/** Answers a store keeps; the oldest answered ones go first, pending ones stay. */
export const MAX_ANSWERS: number = 5000;

function boundAnswers(answers: Map<string, CacheEntry>): void {
  if (answers.size <= MAX_ANSWERS) {
    return;
  }
  for (const [key, entry] of answers) {
    if (answers.size <= MAX_ANSWERS) {
      return;
    }
    if (entry.status !== "pending") {
      answers.delete(key);
    }
  }
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
  enqueue: (key: string, permission: Permission, data: unknown) => void;
  clear: () => void;
};

/**
 * Collects the checks the snapshot cannot answer and posts them as one AuthZEN
 * batch per microtask.
 */
export function createBatch(options: BatchOptions): Batch {
  const { answers, endpoint } = options;
  let queued: {
    readonly permission: Permission;
    readonly data: unknown;
    readonly key: string;
  }[] = [];
  let flushScheduled = false;

  type Queued = (typeof queued)[number];

  const evaluationOf = (
    snapshot: Snapshot,
    principal: Subject["principal"],
    item: Queued,
  ): unknown => ({
    subject: { type: principal?.kind ?? "user", id: principal?.id ?? "" },
    action: { name: item.permission.action },
    resource: {
      type: item.permission.resource,
      id: rowId(snapshot, item.permission, item.data),
      properties: item.data,
    },
  });

  /**
   * Chunks of at most MAX_BATCH_ITEMS items and MAX_BATCH_BYTES serialised
   * bytes; an item over the byte limit goes alone.
   */
  const chunksOf = (
    snapshot: Snapshot,
    principal: Subject["principal"],
    items: readonly Queued[],
  ): { readonly items: Queued[]; readonly evaluations: unknown[] }[] => {
    const chunks: { items: Queued[]; evaluations: unknown[] }[] = [];
    let bytes = 0;
    for (const item of items) {
      const evaluation = evaluationOf(snapshot, principal, item);
      const size = JSON.stringify(evaluation).length + 1;
      const last = chunks.at(-1);
      if (
        last === undefined ||
        last.items.length >= MAX_BATCH_ITEMS ||
        bytes + size > MAX_BATCH_BYTES
      ) {
        chunks.push({ items: [item], evaluations: [evaluation] });
        bytes = size;
      } else {
        last.items.push(item);
        last.evaluations.push(evaluation);
        bytes += size;
      }
    }
    return chunks;
  };

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
    const post = async (chunk: {
      readonly items: Queued[];
      readonly evaluations: unknown[];
    }): Promise<void> => {
      try {
        const response = await options.request(endpoint, {
          evaluations: chunk.evaluations,
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
        for (const [index, item] of chunk.items.entries()) {
          const row = body.evaluations?.[index];
          const decision = row?.context?.permdock ?? SERVER_ONLY;
          answers.set(item.key, { decision, status: "ready" });
        }
      } catch {
        if (started !== options.generation()) {
          return;
        }
        for (const item of chunk.items) {
          answers.set(item.key, {
            decision: SERVER_ONLY,
            status: "server-only",
          });
        }
      }
      options.emit();
    };
    await Promise.all(chunksOf(snapshot, principal, batch).map(post));
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
      boundAnswers(answers);
      options.emitSoon();
      scheduleFlush();
    },
    clear(): void {
      queued = [];
    },
  };
}
