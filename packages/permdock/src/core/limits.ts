import type { LimitStore } from './interfaces.ts';
import type { Grant } from './policy.ts';

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
};

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}

export function limitWindowId(per: string, now: number): string {
  const trimmed = per.trim().toLowerCase();
  const named = UNIT_SECONDS[trimmed];
  if (named !== undefined) {
    return String(Math.floor(now / named));
  }
  const match =
    /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/u.exec(
      trimmed,
    );
  if (match !== null) {
    const amount = Number(match[1]);
    const unit = UNIT_SECONDS[match[2] ?? ''];
    if (unit !== undefined && Number.isFinite(amount) && amount > 0) {
      return String(Math.floor(now / (amount * unit)));
    }
  }
  return '0';
}

export function limitCacheKey(
  subjectId: string,
  key: string,
  per: string,
  now: number,
): string {
  return `${subjectId}:${key}:${per}:${limitWindowId(per, now)}`;
}

export function memoryLimitStore(): LimitStore {
  const used = new Map<string, number>();
  const bucket = (input: {
    readonly key: string;
    readonly subjectId: string;
    readonly per: string;
    readonly now?: number;
  }): string =>
    limitCacheKey(
      input.subjectId,
      input.key,
      input.per,
      input.now ?? Date.now() / 1000,
    );
  return {
    remaining(input) {
      const cap = input.count;
      if (!Number.isFinite(cap) || cap <= 0) {
        return { remaining: -1 };
      }
      const seen = used.get(bucket(input)) ?? 0;
      return { remaining: cap - seen };
    },
    consume(input) {
      const cap = input.count;
      if (!Number.isFinite(cap) || cap <= 0) {
        return { remaining: -1 };
      }
      const id = bucket(input);
      const seen = used.get(id) ?? 0;
      if (seen >= cap) {
        return { remaining: -1 };
      }
      used.set(id, seen + 1);
      return { remaining: cap - seen - 1 };
    },
  };
}

export type QuotaVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'limit' | 'limit-unavailable' };

export function applyQuota(input: {
  readonly store: LimitStore | undefined;
  readonly cache: Map<string, number>;
  readonly grant: Grant;
  readonly permissionKey: string;
  readonly subjectId: string;
  readonly now: number;
  readonly consume: boolean;
}): QuotaVerdict {
  const limit = input.grant.limit;
  if (limit === undefined) {
    return { ok: true };
  }
  if (input.store === undefined) {
    return { ok: false, reason: 'limit-unavailable' };
  }
  const payload = {
    key: input.permissionKey,
    subjectId: input.subjectId,
    count: limit.count,
    per: limit.per,
    now: input.now,
  };
  const cacheKey = limitCacheKey(
    input.subjectId,
    input.permissionKey,
    limit.per,
    input.now,
  );
  if (!input.consume) {
    try {
      const peeked = input.store.remaining(payload);
      if (isThenable(peeked)) {
        return { ok: false, reason: 'limit-unavailable' };
      }
      if (peeked !== undefined) {
        return peeked.remaining > 0
          ? { ok: true }
          : { ok: false, reason: 'limit' };
      }
    } catch {
      return { ok: false, reason: 'limit-unavailable' };
    }
    const cached = input.cache.get(cacheKey);
    if (cached === undefined) {
      return { ok: false, reason: 'limit-unavailable' };
    }
    return cached > 0 ? { ok: true } : { ok: false, reason: 'limit' };
  }
  try {
    const consumed = input.store.consume(payload);
    if (isThenable(consumed)) {
      return { ok: false, reason: 'limit-unavailable' };
    }
    input.cache.set(cacheKey, consumed.remaining);
    if (consumed.remaining < 0) {
      return { ok: false, reason: 'limit' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'limit-unavailable' };
  }
}
