import type { LimitDetail, Obligation, Quota } from "./decision.ts";
import type { LimitStore } from "./interfaces.ts";
import type { Grant, GrantLimit } from "./policy-types.ts";

import { durationOf, nowSeconds, rfc3339 } from "./time.ts";

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/** Throws at definition time for a `limit` no store could count. */
export function assertLimit(
  limit: GrantLimit | undefined,
  permissionKey: string,
): void {
  if (limit === undefined) {
    return;
  }
  if (!Number.isSafeInteger(limit.count) || limit.count <= 0) {
    throw new Error(
      `PermDock: limit count on '${permissionKey}' must be a positive integer`,
    );
  }
  if (durationOf(limit.per) === undefined) {
    throw new Error(
      `PermDock: limit per on '${permissionKey}' must be a whole number of seconds above 0 (3600 for an hour), got ${JSON.stringify(limit.per)}`,
    );
  }
  if (
    limit.mode !== undefined &&
    limit.mode !== "hard" &&
    limit.mode !== "soft"
  ) {
    throw new Error(
      `PermDock: limit mode on '${permissionKey}' must be 'hard' or 'soft'`,
    );
  }
  if (
    limit.alertAt !== undefined &&
    (typeof limit.alertAt !== "number" ||
      !(limit.alertAt > 0 && limit.alertAt <= 1))
  ) {
    throw new Error(
      `PermDock: limit alertAt on '${permissionKey}' must be a fraction above 0 and at most 1`,
    );
  }
}

/** The declared fields of a validated `limit`, so extra keys never reach the grant. */
export function normalizeLimit(
  limit: GrantLimit | undefined,
): GrantLimit | undefined {
  if (limit === undefined) {
    return undefined;
  }
  return {
    count: limit.count,
    per: limit.per,
    ...(limit.mode === undefined ? {} : { mode: limit.mode }),
    ...(limit.alertAt === undefined ? {} : { alertAt: limit.alertAt }),
  };
}

function limitWindowId(per: number, now: number): string | undefined {
  const seconds = durationOf(per);
  return seconds === undefined ? undefined : String(Math.floor(now / seconds));
}

function limitCacheKey(
  input: {
    readonly subjectId: string;
    readonly key: string;
    readonly per: number;
    readonly tenant?: string;
  },
  now: number,
): string | undefined {
  const window = limitWindowId(input.per, now);
  return window === undefined
    ? undefined
    : JSON.stringify([
        input.tenant ?? null,
        input.subjectId,
        input.key,
        input.per,
        window,
      ]);
}

function locate(
  input: Parameters<LimitStore["consume"]>[0],
):
  | { readonly id: string; readonly until: number; readonly now: number }
  | undefined {
  const now = nowSeconds(input.now);
  const seconds = durationOf(input.per);
  const id = limitCacheKey(input, now);
  if (seconds === undefined || id === undefined) {
    return undefined;
  }
  return { id, until: (Math.floor(now / seconds) + 1) * seconds, now };
}

export function memoryLimitStore(): LimitStore & {
  /** Live counters, for tests and diagnostics. */
  size(): number;
} {
  const used = new Map<string, { count: number; until: number }>();
  let earliest = Number.POSITIVE_INFINITY;
  const sweep = (now: number): void => {
    if (now < earliest) {
      return;
    }
    earliest = Number.POSITIVE_INFINITY;
    for (const [id, entry] of used) {
      if (entry.until <= now) {
        used.delete(id);
      } else {
        earliest = Math.min(earliest, entry.until);
      }
    }
  };
  return {
    remaining(input) {
      const cap = input.count;
      const slot = locate(input);
      if (!Number.isFinite(cap) || cap <= 0 || slot === undefined) {
        return { remaining: -1 };
      }
      const seen = used.get(slot.id)?.count ?? 0;
      return { remaining: cap - seen };
    },
    consume(input) {
      const cap = input.count;
      const slot = locate(input);
      if (!Number.isFinite(cap) || cap <= 0 || slot === undefined) {
        return { remaining: -1 };
      }
      sweep(slot.now);
      const seen = used.get(slot.id)?.count ?? 0;
      if (seen >= cap) {
        return { remaining: -1 };
      }
      used.set(slot.id, { count: seen + 1, until: slot.until });
      earliest = Math.min(earliest, slot.until);
      return { remaining: cap - seen - 1 };
    },
    size() {
      return used.size;
    },
  };
}

export type QuotaVerdict =
  | {
      readonly ok: true;
      readonly quota?: Quota;
      readonly obligations?: readonly Obligation[];
    }
  | {
      readonly ok: false;
      readonly reason: "limit";
      readonly detail: LimitDetail;
    }
  | { readonly ok: false; readonly reason: "limit-unavailable" };

/**
 * `left` is what remains once this call counts: the store's answer after
 * `consume`, or one less than `remaining` when only peeking. Below zero the
 * call is past the count.
 */
function verdictFor(
  limit: GrantLimit,
  left: number,
  now: number,
): QuotaVerdict {
  const seconds = durationOf(limit.per);
  if (seconds === undefined) {
    return { ok: false, reason: "limit-unavailable" };
  }
  const resetsAt = rfc3339((Math.floor(now / seconds) + 1) * seconds);
  if (left < 0) {
    return limit.mode === "soft"
      ? {
          ok: true,
          quota: { remaining: 0, resetsAt },
          obligations: [{ kind: "over-limit" }],
        }
      : {
          ok: false,
          reason: "limit",
          detail: { count: limit.count, per: seconds, resetsAt },
        };
  }
  const near =
    limit.alertAt !== undefined &&
    (limit.count - left) / limit.count >= limit.alertAt;
  return near
    ? {
        ok: true,
        quota: { remaining: left, resetsAt },
        obligations: [{ kind: "near-limit" }],
      }
    : { ok: true, quota: { remaining: left, resetsAt } };
}

export function applyQuota(input: {
  readonly store: LimitStore | undefined;
  readonly cache: Map<string, number>;
  readonly grant: Grant;
  readonly permissionKey: string;
  readonly subjectId: string;
  readonly tenant: string | undefined;
  readonly now: number;
  readonly consume: boolean;
}): QuotaVerdict {
  const limit = input.grant.limit;
  if (limit === undefined) {
    return { ok: true };
  }
  if (input.store === undefined) {
    return { ok: false, reason: "limit-unavailable" };
  }
  const payload = {
    key: input.permissionKey,
    subjectId: input.subjectId,
    count: limit.count,
    per: limit.per,
    now: { epochMilliseconds: input.now * 1000 },
    ...(input.tenant === undefined ? {} : { tenant: input.tenant }),
  };
  const cacheKey = limitCacheKey(payload, input.now);
  if (cacheKey === undefined) {
    return { ok: false, reason: "limit-unavailable" };
  }
  if (!input.consume) {
    try {
      const peeked = input.store.remaining(payload);
      if (isThenable(peeked)) {
        return { ok: false, reason: "limit-unavailable" };
      }
      if (peeked !== undefined) {
        return verdictFor(limit, peeked.remaining - 1, input.now);
      }
    } catch {
      return { ok: false, reason: "limit-unavailable" };
    }
    const cached = input.cache.get(cacheKey);
    if (cached === undefined) {
      return { ok: false, reason: "limit-unavailable" };
    }
    return verdictFor(limit, cached - 1, input.now);
  }
  try {
    const consumed = input.store.consume(payload);
    if (isThenable(consumed)) {
      return { ok: false, reason: "limit-unavailable" };
    }
    input.cache.set(cacheKey, consumed.remaining);
    return verdictFor(limit, consumed.remaining, input.now);
  } catch {
    return { ok: false, reason: "limit-unavailable" };
  }
}
