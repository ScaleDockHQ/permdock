import type { Decision, DenialReason } from '../core/decision.ts';
import type { Permission } from '../core/permissions.ts';
import type { Subject } from '../core/subject.ts';
import type { RemotePdpAuth, RemotePdpCache } from './types.ts';

import { decisionToken } from '../core/token.ts';

export const DEFAULT_TIMEOUT_MS = 300;
const MAX_CACHE_TTL_MS = 30_000;
const CACHE_MAX = 1000;

/** Milliseconds, clamped to `[0, 30s]`; anything unparseable disables the cache. */
export function ttlMs(cache: RemotePdpCache | undefined): number {
  if (cache === undefined) {
    return 0;
  }
  const raw =
    typeof cache.ttl === 'number'
      ? cache.ttl
      : cache.ttl.endsWith('ms')
        ? Number(cache.ttl.slice(0, -2))
        : Number(cache.ttl.slice(0, -1)) * 1000;
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.min(raw, MAX_CACHE_TTL_MS);
}

export function denied(reason: DenialReason): Decision {
  return {
    outcome: 'denied',
    denials: [{ role: null, reason }],
    alternatives: [],
  };
}

export function resourceIdOf(data: unknown, field = 'id'): string {
  if (data === null || typeof data !== 'object') {
    return '*';
  }
  const id = Object.hasOwn(data, field)
    ? (data as Record<string, unknown>)[field]
    : undefined;
  if (typeof id === 'string' || typeof id === 'number') {
    return String(id);
  }
  return '*';
}

export function granted(
  provider: string,
  permission: Permission,
  subject: Subject,
  data: unknown,
): Decision {
  const principal = subject.principal;
  if (principal === null) {
    return denied('anonymous');
  }
  return {
    outcome: 'granted',
    subject: { ...subject, principal },
    matched: {
      role: provider,
      permission: permission.key,
      provider,
    },
    token: decisionToken({
      key: permission.key,
      resourceId: resourceIdOf(data),
      principal,
      actor: subject.actor,
      fingerprint: provider,
    }),
  };
}

/**
 * The request that would be sent, plus what a custom mapping may drop
 * (issuer, tenant, actor): a tenant switch or a changed row never reuses a
 * cached answer.
 */
export function cacheKey(
  subject: Subject,
  permission: Permission,
  body: unknown,
): string {
  return JSON.stringify([
    permission.key,
    subject.principal?.issuer ?? null,
    subject.principal?.tenant ?? null,
    subject.actor === undefined ? null : [subject.actor.id, subject.actor.kind],
    body,
  ]);
}

export type TtlCache<T> = {
  readonly get: (key: string) => T | undefined;
  readonly set: (key: string, value: T) => void;
};

export function ttlCache<T>(ttl: number): TtlCache<T> {
  const entries = new Map<string, { readonly at: number; readonly value: T }>();
  return {
    get(key) {
      if (ttl <= 0) {
        return undefined;
      }
      const hit = entries.get(key);
      if (hit !== undefined && Date.now() - hit.at < ttl) {
        return hit.value;
      }
      entries.delete(key);
      return undefined;
    },
    set(key, value) {
      if (ttl <= 0) {
        return;
      }
      entries.set(key, { at: Date.now(), value });
      if (entries.size > CACHE_MAX) {
        const oldest = entries.keys().next();
        if (oldest.done !== true) {
          entries.delete(oldest.value);
        }
      }
    },
  };
}

async function bearerOf(
  auth: RemotePdpAuth | undefined,
): Promise<string | null> {
  if (auth === undefined) {
    return null;
  }
  try {
    const token =
      typeof auth.bearer === 'function' ? await auth.bearer() : auth.bearer;
    return token === '' ? null : token;
  } catch {
    return null;
  }
}

export type PostResult =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false };

export async function postJson(
  fetcher: typeof fetch,
  url: string,
  body: unknown,
  options: {
    readonly auth?: RemotePdpAuth | undefined;
    readonly timeout: number;
  },
): Promise<PostResult> {
  const token = await bearerOf(options.auth);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (token !== null) {
    headers['authorization'] = `Bearer ${token}`;
  }
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeout),
    });
    return response.ok ? { ok: true, response } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function joinUrl(base: string, path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmed}${path.startsWith('/') ? path : `/${path}`}`;
}
