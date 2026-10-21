import type {
  CloudConnectionOptions,
  CloudEndpointOptions,
  CloudEndpoints,
} from "./types.ts";

import { isRecord } from "../core/compact.ts";
import { timeoutSignal } from "../core/timeout.ts";
import { CLOUD_BASE_URL } from "./base-url.ts";

/**
 * Milliseconds a PermDock Cloud request may take; a slower one fails like an
 * unreachable Cloud.
 */
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

function cloudUrl(options: CloudEndpointOptions): string {
  return trimSlash(
    firstNonEmpty(options.url, readEnv("PERMDOCK_CLOUD_URL"), CLOUD_BASE_URL),
  );
}

function endpointsOf(url: string, environment: string): CloudEndpoints {
  const issuer = `${url}/v1/environments/${encodeURIComponent(environment)}`;
  return Object.freeze({ issuer, jwks: `${issuer}/.well-known/jwks.json` });
}

/**
 * `options.environment`, else `PERMDOCK_CLOUD_ENV`, else `""` for the key-bound
 * lookup.
 */
function configuredEnvironment(options: CloudEndpointOptions): string {
  return firstNonEmpty(options.environment, readEnv("PERMDOCK_CLOUD_ENV"));
}

/**
 * The environment URL and JWK Set URL `cloud()` uses when the environment is
 * configured: `environment`, else `PERMDOCK_CLOUD_ENV`. Throws when neither is
 * set; `resolveCloudEndpoints` then asks the Cloud which environment the key
 * belongs to.
 */
export function cloudEndpoints(
  options: CloudEndpointOptions = {},
): CloudEndpoints {
  const url = cloudUrl(options);
  const environment = configuredEnvironment(options);
  if (environment === "") {
    throw new Error(
      "PermDock: cloudEndpoints() requires environment or PERMDOCK_CLOUD_ENV; resolveCloudEndpoints() asks the Cloud for the key's environment.",
    );
  }
  return endpointsOf(url, environment);
}

export type CloudConnection = {
  /**
   * The endpoints when the environment is configured, else `undefined` until
   * resolved.
   */
  readonly known: CloudEndpoints | undefined;
  /**
   * The endpoints; the first call without a configured environment asks `GET
   * /v1/environment`.
   */
  readonly endpoints: () => Promise<CloudEndpoints>;
  /** A request to `<issuer><path>` with the environment key as the bearer token. */
  readonly request: (
    path: string,
    init?: RequestInit,
    accept?: string,
    contentType?: string,
  ) => Promise<Response>;
};

async function keyEnvironment(
  url: string,
  key: string,
  fetchFn: typeof fetch,
): Promise<CloudEndpoints> {
  const response = await fetchFn(`${url}/v1/environment`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: timeoutSignal(CLOUD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `PermDock Cloud did not name the key's environment: HTTP ${String(response.status)}`,
    );
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body["environment"] !== "string") {
    throw new Error(
      "PermDock Cloud answered GET /v1/environment in an unknown shape",
    );
  }
  const endpoints = endpointsOf(url, body["environment"]);
  if (body["issuer"] !== endpoints.issuer) {
    throw new Error(
      `PermDock Cloud named issuer ${String(body["issuer"])}, not ${endpoints.issuer}`,
    );
  }
  return endpoints;
}

/**
 * The authenticated connection every `permdock/cloud` client shares. Throws
 * without a key.
 */
export function cloudConnection(
  options: CloudConnectionOptions,
): CloudConnection {
  const key = firstNonEmpty(options.key, readEnv("PERMDOCK_CLOUD_KEY"));
  const url = cloudUrl(options);
  if (key === "") {
    throw new Error("PermDock: cloud() requires a key (PERMDOCK_CLOUD_KEY).");
  }
  const environment = configuredEnvironment(options);
  const known = environment === "" ? undefined : endpointsOf(url, environment);
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  let pending: Promise<CloudEndpoints> | undefined;
  const endpoints = (): Promise<CloudEndpoints> => {
    if (known !== undefined) {
      return Promise.resolve(known);
    }
    pending ??= keyEnvironment(url, key, fetchFn).catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
  const request = async (
    path: string,
    init: RequestInit = {},
    accept?: string,
    contentType?: string,
  ): Promise<Response> => {
    const { issuer } = await endpoints();
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
    return fetchFn(`${issuer}${path}`, {
      ...init,
      headers,
      signal: timeoutSignal(CLOUD_TIMEOUT_MS, init.signal),
    });
  };
  return Object.freeze({ known, endpoints, request });
}

/**
 * The environment URL and JWK Set URL for a key: `cloudEndpoints(options)` when
 * the environment is configured, else the environment `GET /v1/environment`
 * names for `key` (`PERMDOCK_CLOUD_KEY`). Rejects when the Cloud does not
 * answer or answers another issuer.
 */
export async function resolveCloudEndpoints(
  options: CloudConnectionOptions = {},
): Promise<CloudEndpoints> {
  const connection = cloudConnection(options);
  const endpoints = await connection.endpoints();
  return endpoints;
}

/** `true` for a compact JWS: three dot-separated parts, not JSON. */
export function isCompactJws(value: string): boolean {
  return !value.startsWith("{") && value.split(".").length === 3;
}
