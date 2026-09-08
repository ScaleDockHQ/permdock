import type { TokenFailureCause } from '../core/interfaces.ts';
import type {
  DiscoveryInput,
  JsonWebKeySet,
  JoseTokenVerifierOptions,
} from './types.ts';

import {
  DEFAULT_JWKS_COOLDOWN,
  DEFAULT_JWKS_MAX_TTL,
  DEFAULT_JWKS_MIN_TTL,
  issuerFromDiscovery,
} from './config.ts';

export type ResolvedKeys =
  | { readonly ok: true; readonly jwks: JsonWebKeySet }
  | { readonly ok: false; readonly cause: TokenFailureCause };

type CachedDocument<T> = {
  value: T;
  expiresAt: number;
};

export type KeyCache = {
  resolveJwks(now?: number): Promise<ResolvedKeys>;
  refetchJwks(now?: number): Promise<ResolvedKeys>;
};

function clampTtl(seconds: number, minTtl: number, maxTtl: number): number {
  return Math.min(maxTtl, Math.max(minTtl, seconds));
}

function cacheControlMaxAge(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }
  const match = /max-age=(\d+)/iu.exec(header);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return Math.trunc(Number(match[1]));
}

function discoveryUrls(issuer: string): readonly string[] {
  const url = new URL(issuer);
  const oidc = new URL('/.well-known/openid-configuration', url.origin);
  if (url.pathname !== '/' && url.pathname !== '') {
    oidc.pathname = `${url.pathname.replace(/\/$/u, '')}/.well-known/openid-configuration`;
  }
  const rfc8414 = new URL(url.href);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/u, '');
  rfc8414.pathname = `/.well-known/oauth-authorization-server${path}`;
  return [oidc.href, rfc8414.href];
}

export function createKeyCache(options: JoseTokenVerifierOptions): KeyCache {
  const minTtl = options.jwksCache?.minTtl ?? DEFAULT_JWKS_MIN_TTL;
  const maxTtl = options.jwksCache?.maxTtl ?? DEFAULT_JWKS_MAX_TTL;
  const cooldown = options.jwksCache?.cooldown ?? DEFAULT_JWKS_COOLDOWN;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  let discoveryCache:
    | CachedDocument<{
        readonly issuer: string;
        readonly jwks_uri: string;
      }>
    | undefined;
  let jwksCache: CachedDocument<JsonWebKeySet> | undefined;
  let cooldownUntil = 0;
  let discoveryCause: TokenFailureCause | undefined;

  const readDiscovery = async (
    href: string,
    issuer: string,
    now: number,
  ): Promise<
    | { readonly ok: true; readonly issuer: string; readonly jwks_uri: string }
    | { readonly ok: false; readonly cause: TokenFailureCause }
    | undefined
  > => {
    try {
      const response = await fetchImpl(href, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        return undefined;
      }
      const body = (await response.json()) as {
        readonly issuer?: string;
        readonly jwks_uri?: string;
      };
      if (body.issuer !== issuer) {
        discoveryCause = 'discovery-mismatch';
        return { ok: false, cause: 'discovery-mismatch' };
      }
      if (typeof body.jwks_uri !== 'string') {
        return undefined;
      }
      const ttl = clampTtl(
        cacheControlMaxAge(response.headers.get('cache-control')) ?? maxTtl,
        minTtl,
        maxTtl,
      );
      discoveryCache = {
        value: { issuer: body.issuer, jwks_uri: body.jwks_uri },
        expiresAt: now + ttl,
      };
      discoveryCause = undefined;
      return { ok: true, ...discoveryCache.value };
    } catch {
      return undefined;
    }
  };

  const loadDiscovery = async (
    discovery: DiscoveryInput,
    now: number,
  ): Promise<
    | { readonly ok: true; readonly issuer: string; readonly jwks_uri: string }
    | { readonly ok: false; readonly cause: TokenFailureCause }
  > => {
    if (
      typeof discovery !== 'string' &&
      discovery.metadata?.jwks_uri !== undefined
    ) {
      const issuer = issuerFromDiscovery(discovery);
      if (
        discovery.metadata.issuer !== undefined &&
        discovery.metadata.issuer !== issuer
      ) {
        discoveryCause = 'discovery-mismatch';
        return { ok: false, cause: 'discovery-mismatch' };
      }
      return { ok: true, issuer, jwks_uri: discovery.metadata.jwks_uri };
    }
    if (discoveryCache !== undefined && discoveryCache.expiresAt > now) {
      return { ok: true, ...discoveryCache.value };
    }
    const issuer = issuerFromDiscovery(discovery);
    const [oidc, rfc8414] = discoveryUrls(issuer);
    const fromOidc =
      oidc === undefined ? undefined : await readDiscovery(oidc, issuer, now);
    if (fromOidc !== undefined) {
      return fromOidc;
    }
    const fromRfc8414 =
      rfc8414 === undefined
        ? undefined
        : await readDiscovery(rfc8414, issuer, now);
    if (fromRfc8414 !== undefined) {
      return fromRfc8414;
    }
    if (discoveryCache !== undefined) {
      return { ok: true, ...discoveryCache.value };
    }
    return { ok: false, cause: discoveryCause ?? 'discovery-unavailable' };
  };

  const loadJwks = async (
    href: string,
    now: number,
    force: boolean,
  ): Promise<ResolvedKeys> => {
    if (!force && jwksCache !== undefined && jwksCache.expiresAt > now) {
      return { ok: true, jwks: jwksCache.value };
    }
    try {
      const response = await fetchImpl(href, {
        headers: { accept: 'application/jwk-set+json, application/json' },
      });
      if (!response.ok) {
        throw new Error('jwks fetch failed');
      }
      const body = (await response.json()) as JsonWebKeySet;
      if (!Array.isArray(body.keys) || body.keys.length === 0) {
        throw new Error('empty jwks');
      }
      const ttl = clampTtl(
        cacheControlMaxAge(response.headers.get('cache-control')) ?? maxTtl,
        minTtl,
        maxTtl,
      );
      jwksCache = { value: body, expiresAt: now + ttl };
      return { ok: true, jwks: body };
    } catch {
      if (jwksCache !== undefined && jwksCache.expiresAt > now) {
        return { ok: true, jwks: jwksCache.value };
      }
      return { ok: false, cause: 'jwks-unavailable' };
    }
  };

  const resolve = async (
    force: boolean,
    nowInput?: number,
  ): Promise<ResolvedKeys> => {
    const now = nowInput ?? Math.floor(Date.now() / 1000);
    if (options.jwks instanceof URL) {
      return loadJwks(options.jwks.href, now, force);
    }
    if (
      options.jwks !== undefined &&
      typeof options.jwks === 'object' &&
      'keys' in options.jwks
    ) {
      return { ok: true, jwks: options.jwks };
    }
    if (options.discovery === undefined) {
      return { ok: false, cause: 'jwks-unavailable' };
    }
    const discovered = await loadDiscovery(options.discovery, now);
    if (!discovered.ok) {
      return discovered;
    }
    return loadJwks(discovered.jwks_uri, now, force);
  };

  return {
    resolveJwks(now?: number): Promise<ResolvedKeys> {
      return resolve(false, now);
    },
    refetchJwks(now?: number): Promise<ResolvedKeys> {
      const current = now ?? Math.floor(Date.now() / 1000);
      if (current < cooldownUntil) {
        return resolve(false, current);
      }
      cooldownUntil = current + cooldown;
      return resolve(true, current);
    },
  };
}
