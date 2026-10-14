import type {
  CloudConnectionOptions,
  CloudEndpointOptions,
  CloudEndpoints,
} from "./types.ts";

import { timeoutSignal } from "../core/timeout.ts";

/** Milliseconds a PermDock Cloud request may take; a slower one fails like an unreachable Cloud. */
const CLOUD_TIMEOUT_MS = 10_000;

function readEnv(name: string): string {
  // SAFETY: process is optional here and the env value is typeof-checked before use.
  const runtime = globalThis as {
    readonly process?: { readonly env?: Record<string, string | undefined> };
  };
  const value = runtime.process?.env?.[name];
  return typeof value === "string" ? value : "";
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return "";
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * The environment URL and JWK Set URL `cloud()` uses, resolved with the same
 * fallbacks (`PERMDOCK_CLOUD_URL`; `PERMDOCK_CLOUD_ENV`, `VERCEL_ENV`, `production`).
 */
export function cloudEndpoints(
  options: CloudEndpointOptions = {},
): CloudEndpoints {
  const url = trimSlash(
    firstNonEmpty(options.url, readEnv("PERMDOCK_CLOUD_URL")),
  );
  if (url === "") {
    throw new Error("PermDock: cloud() requires url and key.");
  }
  const environment = firstNonEmpty(
    options.environment,
    readEnv("PERMDOCK_CLOUD_ENV"),
    readEnv("VERCEL_ENV"),
    "production",
  );
  const issuer = `${url}/v1/environments/${encodeURIComponent(environment)}`;
  return Object.freeze({ issuer, jwks: `${issuer}/.well-known/jwks.json` });
}

export type CloudConnection = CloudEndpoints & {
  /** A request to `<issuer><path>` with the environment key as the bearer token. */
  readonly request: (
    path: string,
    init?: RequestInit,
    accept?: string,
    contentType?: string,
  ) => Promise<Response>;
};

/** The authenticated connection every `permdock/cloud` client shares. Throws without a URL or key. */
export function cloudConnection(
  options: CloudConnectionOptions,
): CloudConnection {
  const key = firstNonEmpty(options.key, readEnv("PERMDOCK_CLOUD_KEY"));
  if (key === "") {
    throw new Error("PermDock: cloud() requires url and key.");
  }
  const endpoints = cloudEndpoints(options);
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const request = (
    path: string,
    init: RequestInit = {},
    accept?: string,
    contentType?: string,
  ): Promise<Response> => {
    const headers = new Headers();
    headers.set("authorization", `Bearer ${key}`);
    headers.set("content-type", "application/json");
    for (const [name, value] of new Headers(init.headers)) {
      headers.set(name, value);
    }
    if (accept !== undefined) {
      headers.set("accept", accept);
    }
    if (contentType !== undefined) {
      headers.set("content-type", contentType);
    }
    return fetchFn(`${endpoints.issuer}${path}`, {
      ...init,
      headers,
      signal: timeoutSignal(CLOUD_TIMEOUT_MS, init.signal),
    });
  };
  return Object.freeze({ ...endpoints, request });
}

/** `true` for a compact JWS: three dot-separated parts, not JSON. */
export function isCompactJws(value: string): boolean {
  return !value.startsWith("{") && value.split(".").length === 3;
}
