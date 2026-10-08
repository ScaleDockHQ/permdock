import type { TokenFailureCause } from "../core/interfaces.ts";
import type {
  DiscoveryInput,
  JsonWebKeySet,
  JoseTokenVerifierOptions,
} from "./types.ts";

import {
  DEFAULT_JWKS_COOLDOWN,
  DEFAULT_JWKS_MAX_TTL,
  DEFAULT_JWKS_MIN_TTL,
  DEFAULT_JWKS_TIMEOUT,
  issuerFromDiscovery,
} from "./config.ts";

export type ResolvedKeys =
  | { readonly ok: true; readonly jwks: JsonWebKeySet }
  | { readonly ok: false; readonly cause: TokenFailureCause };

type DiscoveryResult =
  | { readonly ok: true; readonly issuer: string; readonly jwks_uri: string }
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

function isHttpsUrl(value: unknown): value is string {
  return typeof value === "string" && URL.parse(value)?.protocol === "https:";
}

function discoveryUrls(issuer: string): readonly string[] {
  const url = new URL(issuer);
  const oidc = new URL("/.well-known/openid-configuration", url.origin);
  if (url.pathname !== "/" && url.pathname !== "") {
    oidc.pathname = `${url.pathname.replace(/\/$/u, "")}/.well-known/openid-configuration`;
  }
  const rfc8414 = new URL(url.href);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/u, "");
  rfc8414.pathname = `/.well-known/oauth-authorization-server${path}`;
  return [oidc.href, rfc8414.href];
}

export function createKeyCache(options: JoseTokenVerifierOptions): KeyCache {
  const minTtl = options.jwksCache?.minTtl ?? DEFAULT_JWKS_MIN_TTL;
  const maxTtl = options.jwksCache?.maxTtl ?? DEFAULT_JWKS_MAX_TTL;
  const cooldown = options.jwksCache?.cooldown ?? DEFAULT_JWKS_COOLDOWN;
  const timeout = options.jwksCache?.timeout ?? DEFAULT_JWKS_TIMEOUT;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const jwksInFlight = new Map<string, Promise<ResolvedKeys>>();
  let discoveryInFlight: Promise<DiscoveryResult> | undefined;
  let discoveryCache:
    | CachedDocument<{
        readonly issuer: string;
        readonly jwks_uri: string;
      }>
    | undefined;
  /** Keyed by `jwks_uri`: keys cached for one URI never answer for another. */
  let jwksCache:
    | (CachedDocument<JsonWebKeySet> & { readonly href: string })
    | undefined;
  const cachedJwks = (href: string, now: number): JsonWebKeySet | undefined =>
    jwksCache?.href === href && jwksCache.expiresAt > now
      ? jwksCache.value
      : undefined;
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
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        return undefined;
      }
      // SAFETY: issuer is compared to the configured string and jwks_uri is typeof-checked below.
      const body = (await response.json()) as {
        readonly issuer?: string;
        readonly jwks_uri?: string;
      };
      if (body.issuer !== issuer) {
        discoveryCause = "discovery-mismatch";
        return { ok: false, cause: "discovery-mismatch" };
      }
      if (!isHttpsUrl(body.jwks_uri)) {
        return undefined;
      }
      const ttl = clampTtl(
        cacheControlMaxAge(response.headers.get("cache-control")) ?? maxTtl,
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

  const loadDiscovery = (
    discovery: DiscoveryInput,
    now: number,
  ): Promise<
    | { readonly ok: true; readonly issuer: string; readonly jwks_uri: string }
    | { readonly ok: false; readonly cause: TokenFailureCause }
  > => {
    if (
      typeof discovery !== "string" &&
      discovery.metadata?.jwks_uri !== undefined
    ) {
      const issuer = issuerFromDiscovery(discovery);
      if (
        discovery.metadata.issuer !== undefined &&
        discovery.metadata.issuer !== issuer
      ) {
        discoveryCause = "discovery-mismatch";
        return Promise.resolve({ ok: false, cause: "discovery-mismatch" });
      }
      return Promise.resolve({
        ok: true,
        issuer,
        jwks_uri: discovery.metadata.jwks_uri,
      });
    }
    if (discoveryCache !== undefined && discoveryCache.expiresAt > now) {
      return Promise.resolve({ ok: true, ...discoveryCache.value });
    }
    discoveryInFlight ??= fetchDiscovery(discovery, now).finally(() => {
      discoveryInFlight = undefined;
    });
    return discoveryInFlight;
  };

  const fetchDiscovery = async (
    discovery: DiscoveryInput,
    now: number,
  ): Promise<DiscoveryResult> => {
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
    return { ok: false, cause: discoveryCause ?? "discovery-unavailable" };
  };

  const loadJwks = (
    href: string,
    now: number,
    force: boolean,
  ): Promise<ResolvedKeys> => {
    const cached = force ? undefined : cachedJwks(href, now);
    if (cached !== undefined) {
      return Promise.resolve({ ok: true, jwks: cached });
    }
    const pending = jwksInFlight.get(href);
    if (pending !== undefined) {
      return pending;
    }
    const fetched = fetchJwks(href, now).finally(() => {
      jwksInFlight.delete(href);
    });
    jwksInFlight.set(href, fetched);
    return fetched;
  };

  const fetchJwks = async (
    href: string,
    now: number,
  ): Promise<ResolvedKeys> => {
    try {
      const response = await fetchImpl(href, {
        headers: { accept: "application/jwk-set+json, application/json" },
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        throw new Error("jwks fetch failed");
      }
      // SAFETY: keys is checked to be a non-empty array next; jose validates each key on import.
      const body = (await response.json()) as JsonWebKeySet;
      if (!Array.isArray(body.keys) || body.keys.length === 0) {
        throw new Error("empty jwks");
      }
      const ttl = clampTtl(
        cacheControlMaxAge(response.headers.get("cache-control")) ?? maxTtl,
        minTtl,
        maxTtl,
      );
      jwksCache = { href, value: body, expiresAt: now + ttl };
      return { ok: true, jwks: body };
    } catch {
      const stale = cachedJwks(href, now);
      if (stale !== undefined) {
        return { ok: true, jwks: stale };
      }
      return { ok: false, cause: "jwks-unavailable" };
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
    if (typeof options.jwks === "string") {
      return loadJwks(options.jwks, now, force);
    }
    if (
      options.jwks !== undefined &&
      typeof options.jwks === "object" &&
      "keys" in options.jwks
    ) {
      return { ok: true, jwks: options.jwks };
    }
    if (options.discovery === undefined) {
      return { ok: false, cause: "jwks-unavailable" };
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
