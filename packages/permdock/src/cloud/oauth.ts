import type { Instant } from "../core/time.ts";

import { compact, isRecord } from "../core/compact.ts";
import { secondsAt } from "../core/time.ts";
import { timeoutSignal } from "../core/timeout.ts";
import { readBodyText } from "../server/body-text.ts";
import {
  discoverAuthorizationServer,
  parseToken,
  stringField,
} from "../terminal/device.ts";
import { CLOUD_BASE_URL, type CloudScope } from "./base-url.ts";
import { bearerChallenge } from "./challenge.ts";
import { CloudAuthError } from "./oauth-error.ts";
import { pkce, randomToken } from "./pkce.ts";

/** Milliseconds a Cloud OAuth or read request may take; a slower one fails with `unreachable`. */
const OAUTH_TIMEOUT_MS = 10_000;

const DEFAULT_SCOPES: readonly CloudScope[] = ["projects:read", "policy:read"];

export type CloudOAuthOptions = {
  /** The client id the dashboard issued, or one from `/oauth/register`. */
  readonly clientId: string;
  /** Registered with the client; the Cloud redirects here with `code` and `state`. */
  readonly redirectUri: string;
  /** A confidential client's secret, sent as `client_secret_basic` (RFC 6749 section 2.3.1). Server-only. */
  readonly clientSecret?: string;
  /** The Cloud base URL and platform issuer; defaults to `CLOUD_BASE_URL`. */
  readonly url?: string;
  /** Requested on `authorizeUrl`; defaults to `projects:read` and `policy:read`. */
  readonly scopes?: readonly CloudScope[];
  readonly fetch?: typeof fetch;
  /** The clock `expires_at` is computed from; defaults to the system clock. */
  readonly now?: () => Instant;
};

/** A token response, with RFC 6749 field names; `expires_at` is seconds since the epoch. */
export type CloudCredential = {
  readonly access_token: string;
  readonly token_type?: string;
  readonly expires_at?: number;
  readonly refresh_token?: string;
  readonly scope?: string;
};

/** A started authorization. Keep `state` and `codeVerifier` server-side until the callback. */
export type CloudAuthorization = {
  /** Where to send the browser. */
  readonly url: string;
  readonly state: string;
  readonly codeVerifier: string;
};

/** `GET /v1/projects` item. A project is one environment: `id` is the `{env}` of `/v1/environments/{env}`. */
export type CloudProject = {
  readonly id: string;
  readonly name: string;
  readonly environment: string;
  readonly slug?: string;
  readonly issuer?: string;
  readonly catalog?: {
    readonly version: number;
    readonly fingerprint: string;
  };
  readonly updatedAt?: string;
};

export type CloudProjectPage = {
  readonly items: readonly CloudProject[];
  /** Pass back as `cursor` for the next page. */
  readonly next?: string;
};

export type CloudOAuthClient = {
  /** The platform issuer the client discovers its endpoints from. */
  readonly issuer: string;
  /** An authorization code request with PKCE `S256` and a fresh `state`. */
  readonly authorizeUrl: (options?: {
    readonly scopes?: readonly CloudScope[];
  }) => Promise<CloudAuthorization>;
  /**
   * Redeems the callback URL. Throws `state-mismatch` unless it echoes
   * `pending.state`, `issuer-mismatch` for an RFC 9207 `iss` of another
   * server, and `authorization-denied` for an `error` or a missing `code`.
   */
  readonly exchangeCode: (
    callback: string | URL,
    pending: Pick<CloudAuthorization, "state" | "codeVerifier">,
  ) => Promise<CloudCredential>;
  readonly refresh: (refreshToken: string) => Promise<CloudCredential>;
  /** `GET /v1/projects` with a login holding `projects:read`. */
  readonly listProjects: (
    accessToken: string,
    options?: { readonly cursor?: string },
  ) => Promise<CloudProjectPage>;
};

type Endpoints = {
  readonly authorization: string;
  readonly token: string;
};

function trimSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

/** The form-urlencoding RFC 6749 section 2.3.1 applies to client_secret_basic credentials. */
function formEncode(value: string): string {
  return encodeURIComponent(value).replaceAll("%20", "+");
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

/** An endpoint must be `https:`, except on a loopback issuer, which a local Cloud serves over plain HTTP. */
function secureEndpoint(value: string, issuer: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && isLoopback(new URL(issuer).hostname))
    );
  } catch {
    return false;
  }
}

async function readRecord(
  response: Response,
): Promise<Record<string, unknown> | null> {
  const text = await readBodyText(response);
  if (!text.ok) {
    return null;
  }
  try {
    const body: unknown = JSON.parse(text.text);
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function parseProject(value: unknown): CloudProject | null {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    value["id"] === "" ||
    typeof value["name"] !== "string" ||
    typeof value["environment"] !== "string" ||
    value["environment"] === "" ||
    !optionalString(value["slug"]) ||
    !optionalString(value["issuer"]) ||
    !optionalString(value["updatedAt"])
  ) {
    return null;
  }
  const catalog = value["catalog"];
  if (
    catalog !== undefined &&
    (!isRecord(catalog) ||
      !Number.isInteger(catalog["version"]) ||
      typeof catalog["fingerprint"] !== "string")
  ) {
    return null;
  }
  return compact<CloudProject>({
    id: value["id"],
    name: value["name"],
    environment: value["environment"],
    slug: value["slug"],
    issuer: value["issuer"],
    catalog:
      isRecord(catalog) &&
      typeof catalog["version"] === "number" &&
      typeof catalog["fingerprint"] === "string"
        ? { version: catalog["version"], fingerprint: catalog["fingerprint"] }
        : undefined,
    updatedAt: value["updatedAt"],
  });
}

function refusal(response: Response): CloudAuthError {
  const challenge = bearerChallenge(response.headers.get("www-authenticate"));
  const error = challenge?.params["error"];
  const status = response.status;
  if (status === 401) {
    return new CloudAuthError(
      "invalid-token",
      "PermDock Cloud refused the access token; refresh it or sign in again",
      compact({ status, error: error ?? "invalid_token" }),
    );
  }
  if (status === 403 && error === "insufficient_scope") {
    const scope = challenge?.params["scope"];
    return new CloudAuthError(
      "insufficient-scope",
      `The access token lacks ${scope ?? "a required scope"}; sign in again with it`,
      compact({ status, error, scope }),
    );
  }
  if (status === 403) {
    return new CloudAuthError(
      "forbidden",
      "The access token may not read this resource",
      compact({ status, error }),
    );
  }
  if (status === 429) {
    return new CloudAuthError(
      "rate-limited",
      `PermDock Cloud rate-limited the request; retry after ${response.headers.get("retry-after") ?? "a while"} seconds`,
      { status },
    );
  }
  return new CloudAuthError(
    "unexpected-response",
    `PermDock Cloud answered HTTP ${String(status)}`,
    { status },
  );
}

/**
 * An OAuth 2.0 client of the PermDock Cloud platform issuer, for an app that
 * signs its users in to PermDock Cloud and reads their projects. Endpoints come
 * from the issuer's RFC 8414 metadata; every call throws a `CloudAuthError`.
 */
export function cloudOAuth(options: CloudOAuthOptions): CloudOAuthClient {
  const issuer = trimSlash(options.url ?? CLOUD_BASE_URL);
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const scopes = options.scopes ?? DEFAULT_SCOPES;
  let discovered: Promise<Endpoints> | undefined;

  const discover = async (): Promise<Endpoints> => {
    const body = await discoverAuthorizationServer(issuer, { fetch: fetchFn });
    const authorization =
      body === null ? undefined : stringField(body, "authorization_endpoint");
    const token =
      body === null ? undefined : stringField(body, "token_endpoint");
    const methods = body?.["code_challenge_methods_supported"];
    if (
      authorization === undefined ||
      token === undefined ||
      !secureEndpoint(authorization, issuer) ||
      !secureEndpoint(token, issuer) ||
      !Array.isArray(methods) ||
      !methods.includes("S256")
    ) {
      throw new CloudAuthError(
        "discovery-failed",
        `No usable RFC 8414 metadata for ${issuer}`,
      );
    }
    return { authorization, token };
  };

  const endpoints = (): Promise<Endpoints> => {
    discovered ??= discover().catch((error: unknown) => {
      discovered = undefined;
      throw error;
    });
    return discovered;
  };

  const send = async (
    url: string | URL,
    init: RequestInit,
  ): Promise<Response> => {
    try {
      return await fetchFn(url, {
        ...init,
        signal: timeoutSignal(OAUTH_TIMEOUT_MS),
      });
    } catch {
      throw new CloudAuthError(
        "unreachable",
        `PermDock Cloud at ${issuer} did not answer`,
      );
    }
  };

  const token = async (
    fields: Readonly<Record<string, string>>,
  ): Promise<CloudCredential> => {
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    });
    const form = new URLSearchParams(fields);
    if (options.clientSecret === undefined) {
      form.set("client_id", options.clientId);
    } else {
      headers.set(
        "authorization",
        `Basic ${btoa(`${formEncode(options.clientId)}:${formEncode(options.clientSecret)}`)}`,
      );
    }
    const response = await send((await endpoints()).token, {
      method: "POST",
      headers,
      body: form,
    });
    const body = await readRecord(response);
    if (body === null) {
      throw new CloudAuthError(
        "unexpected-response",
        "PermDock Cloud answered the token request with a body that is not a JSON object",
        { status: response.status },
      );
    }
    const parsed = parseToken(body, secondsAt(options.now?.()));
    if (!parsed.ok || !response.ok) {
      const error = parsed.ok ? undefined : parsed.error;
      throw new CloudAuthError(
        "token-refused",
        `PermDock Cloud refused the token request${error === undefined ? "" : `: ${error}`}`,
        compact({ status: response.status, error }),
      );
    }
    return parsed.credential;
  };

  return Object.freeze({
    issuer,
    async authorizeUrl(request = {}) {
      const { authorization } = await endpoints();
      const { verifier, challenge } = await pkce();
      const state = randomToken(16);
      const url = new URL(authorization);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", options.redirectUri);
      url.searchParams.set("scope", (request.scopes ?? scopes).join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return Object.freeze({
        url: url.href,
        state,
        codeVerifier: verifier,
      });
    },
    async exchangeCode(callback, pending) {
      let params: URLSearchParams;
      try {
        params = new URL(callback).searchParams;
      } catch {
        throw new CloudAuthError(
          "authorization-denied",
          "The callback is not a URL",
        );
      }
      if (pending.state === "" || params.get("state") !== pending.state) {
        throw new CloudAuthError(
          "state-mismatch",
          "The callback does not echo the state of the authorization",
        );
      }
      const iss = params.get("iss");
      if (iss !== null && trimSlash(iss) !== issuer) {
        throw new CloudAuthError(
          "issuer-mismatch",
          `The callback names the issuer ${iss}, not ${issuer}`,
        );
      }
      const error = params.get("error");
      const code = params.get("code");
      if (error !== null || code === null || code === "") {
        throw new CloudAuthError(
          "authorization-denied",
          `The authorization was not granted${error === null ? "" : `: ${error}`}`,
          error === null ? {} : { error },
        );
      }
      const credential = await token({
        grant_type: "authorization_code",
        code,
        redirect_uri: options.redirectUri,
        code_verifier: pending.codeVerifier,
      });
      return credential;
    },
    refresh(refreshToken) {
      return token({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
    },
    async listProjects(accessToken, request = {}) {
      const url = new URL(`${issuer}/v1/projects`);
      if (request.cursor !== undefined) {
        url.searchParams.set("cursor", request.cursor);
      }
      const response = await send(url, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        },
      });
      if (!response.ok) {
        throw refusal(response);
      }
      const body = await readRecord(response);
      const raw = body?.["items"];
      const items = Array.isArray(raw) ? raw.map(parseProject) : null;
      const next = body?.["next"];
      if (items === null || items.includes(null) || !optionalString(next)) {
        throw new CloudAuthError(
          "unexpected-response",
          "PermDock Cloud sent a project list that does not match cloud-api-v1.json",
          { status: response.status },
        );
      }
      return Object.freeze(
        compact<CloudProjectPage>({
          items: Object.freeze(
            items.filter((item): item is CloudProject => item !== null),
          ),
          next,
        }),
      );
    },
  });
}
