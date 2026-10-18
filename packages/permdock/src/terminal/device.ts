import type {
  DeviceFlowOptions,
  StoredCredential,
  TerminalRuntime,
} from "./types.ts";

import { compact, isRecord } from "../core/compact.ts";
import { secondsAt } from "../core/time.ts";
import { timeoutSignal } from "../core/timeout.ts";
import { readBodyText } from "../server/body-text.ts";

/** Milliseconds an authorization server request may take. */
export const TERMINAL_TIMEOUT_MS = 10_000;

type DeviceAuthorization = {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly expires_in: number;
  readonly interval?: number;
};

async function readJson(
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

/** POSTs a form and reads a JSON object back; any network or parse failure is `null`. */
export async function postForm(
  runtime: TerminalRuntime,
  url: string,
  fields: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const fetchImpl = runtime.fetch ?? fetch;
  try {
    return await readJson(
      await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
        signal: timeoutSignal(TERMINAL_TIMEOUT_MS),
      }),
    );
  } catch {
    return null;
  }
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

/**
 * Where RFC 8414 metadata may live: the well-known segment inserted before
 * the issuer's path (section 3.1), then appended after it for servers that
 * predate the rule. An issuer without a path has one location.
 */
function metadataUrls(issuer: string): readonly string[] {
  const parsed = new URL(issuer);
  const path = withoutTrailingSlash(parsed.pathname);
  const inserted = `${parsed.origin}/.well-known/oauth-authorization-server${path}`;
  return path === ""
    ? [inserted]
    : [
        inserted,
        `${withoutTrailingSlash(issuer)}/.well-known/oauth-authorization-server`,
      ];
}

/**
 * The issuer's RFC 8414 metadata, or `null`. Metadata whose `issuer` is not
 * the configured issuer is refused (section 3.3), so a mix-up never routes a
 * credential to another server.
 */
export async function discoverAuthorizationServer(
  issuer: string,
  runtime: TerminalRuntime,
): Promise<Record<string, unknown> | null> {
  const fetchImpl = runtime.fetch ?? fetch;
  let urls: readonly string[];
  try {
    urls = metadataUrls(issuer);
  } catch {
    return null;
  }
  for (const url of urls) {
    let body: Record<string, unknown> | null;
    try {
      const response = await fetchImpl(url, {
        signal: timeoutSignal(TERMINAL_TIMEOUT_MS),
      });
      body = response.ok ? await readJson(response) : null;
    } catch {
      body = null;
    }
    if (body === null) {
      continue;
    }
    return typeof body["issuer"] === "string" &&
      withoutTrailingSlash(body["issuer"]) === withoutTrailingSlash(issuer)
      ? body
      : null;
  }
  return null;
}

async function discoverDeviceEndpoints(
  issuer: string,
  runtime: TerminalRuntime,
): Promise<{
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly revocationEndpoint?: string;
}> {
  const body = await discoverAuthorizationServer(issuer, runtime);
  if (body === null) {
    return {};
  }
  return compact({
    authorizationEndpoint: stringField(body, "device_authorization_endpoint"),
    tokenEndpoint: stringField(body, "token_endpoint"),
    revocationEndpoint: stringField(body, "revocation_endpoint"),
  });
}

export function stringField(
  body: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const value = body[name];
  return typeof value === "string" ? value : undefined;
}

function parseAuthorization(
  body: Record<string, unknown>,
): DeviceAuthorization | null {
  if (
    typeof body["device_code"] !== "string" ||
    typeof body["user_code"] !== "string" ||
    typeof body["verification_uri"] !== "string" ||
    typeof body["expires_in"] !== "number"
  ) {
    return null;
  }
  return compact<DeviceAuthorization>({
    device_code: body["device_code"],
    user_code: body["user_code"],
    verification_uri: body["verification_uri"],
    verification_uri_complete:
      typeof body["verification_uri_complete"] === "string"
        ? body["verification_uri_complete"]
        : undefined,
    expires_in: body["expires_in"],
    interval:
      typeof body["interval"] === "number" ? body["interval"] : undefined,
  });
}

type ParsedToken =
  | { readonly ok: true; readonly credential: StoredCredential }
  | { readonly ok: false; readonly error: string };

export function parseToken(
  body: Record<string, unknown>,
  now: number,
): ParsedToken {
  if (typeof body["error"] === "string") {
    return { ok: false, error: body["error"] };
  }
  if (typeof body["access_token"] !== "string") {
    return { ok: false, error: "invalid-token" };
  }
  return {
    ok: true,
    credential: compact<StoredCredential>({
      access_token: body["access_token"],
      refresh_token:
        typeof body["refresh_token"] === "string"
          ? body["refresh_token"]
          : undefined,
      expires_at:
        typeof body["expires_in"] === "number"
          ? now + body["expires_in"]
          : undefined,
      token_type:
        typeof body["token_type"] === "string" ? body["token_type"] : undefined,
      scope: stringField(body, "scope"),
    }),
  };
}

export async function runDeviceFlow(
  device: DeviceFlowOptions,
  runtime: TerminalRuntime,
  write: (text: string) => void,
): Promise<StoredCredential | null> {
  const sleep = runtime.sleep ?? defaultSleep;
  const now = (): number => secondsAt(runtime.now?.());
  let authorizationEndpoint = device.authorizationEndpoint;
  let tokenEndpoint = device.tokenEndpoint;
  if (
    (authorizationEndpoint === undefined || tokenEndpoint === undefined) &&
    device.issuer !== undefined
  ) {
    const discovered = await discoverDeviceEndpoints(device.issuer, runtime);
    authorizationEndpoint =
      authorizationEndpoint ?? discovered.authorizationEndpoint;
    tokenEndpoint = tokenEndpoint ?? discovered.tokenEndpoint;
  }
  if (authorizationEndpoint === undefined || tokenEndpoint === undefined) {
    return null;
  }
  const startedBody = await postForm(runtime, authorizationEndpoint, {
    client_id: device.clientId,
    scope: device.scope ?? "",
  });
  const authorization =
    startedBody === null ? null : parseAuthorization(startedBody);
  if (authorization === null) {
    return null;
  }
  device.onPrompt?.(
    compact({
      user_code: authorization.user_code,
      verification_uri: authorization.verification_uri,
      verification_uri_complete: authorization.verification_uri_complete,
    }),
  );
  write(
    `Visit ${authorization.verification_uri} and enter ${authorization.user_code}\n`,
  );
  if (authorization.verification_uri_complete !== undefined) {
    device.open?.(authorization.verification_uri_complete);
  }
  let interval = authorization.interval ?? 5;
  const deadline = now() + authorization.expires_in;
  while (now() < deadline) {
    await sleep(interval * 1000);
    const polledBody = await postForm(runtime, tokenEndpoint, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: authorization.device_code,
      client_id: device.clientId,
    });
    if (polledBody === null) {
      return null;
    }
    const token = parseToken(polledBody, now());
    if (token.ok) {
      return token.credential;
    }
    if (token.error === "slow_down") {
      interval += 5;
      continue;
    }
    if (token.error === "authorization_pending") {
      continue;
    }
    return null;
  }
  return null;
}

export async function refreshCredential(
  device: DeviceFlowOptions,
  credential: StoredCredential,
  runtime: TerminalRuntime,
): Promise<StoredCredential | null> {
  if (credential.refresh_token === undefined) {
    return null;
  }
  const now = (): number => secondsAt(runtime.now?.());
  let tokenEndpoint = device.tokenEndpoint;
  if (tokenEndpoint === undefined && device.issuer !== undefined) {
    tokenEndpoint = (await discoverDeviceEndpoints(device.issuer, runtime))
      .tokenEndpoint;
  }
  if (tokenEndpoint === undefined) {
    return null;
  }
  const body = await postForm(runtime, tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: credential.refresh_token,
    client_id: device.clientId,
  });
  if (body === null) {
    return null;
  }
  const token = parseToken(body, now());
  return token.ok ? token.credential : null;
}

export async function revokeCredential(
  device: DeviceFlowOptions | undefined,
  credential: StoredCredential,
  runtime: TerminalRuntime,
): Promise<void> {
  if (device === undefined || credential.refresh_token === undefined) {
    return;
  }
  let revocationEndpoint = device.revocationEndpoint;
  if (revocationEndpoint === undefined && device.issuer !== undefined) {
    revocationEndpoint = (await discoverDeviceEndpoints(device.issuer, runtime))
      .revocationEndpoint;
  }
  if (revocationEndpoint === undefined) {
    return;
  }
  await postForm(runtime, revocationEndpoint, {
    token: credential.refresh_token,
    token_type_hint: "refresh_token",
    client_id: device.clientId,
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
