import type {
  DeviceFlowOptions,
  StoredCredential,
  TerminalRuntime,
} from './types.ts';

import { compact } from '../core/compact.ts';

type DeviceAuthorization = {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly expires_in: number;
  readonly interval?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

export async function discoverDeviceEndpoints(
  issuer: string,
  runtime: TerminalRuntime,
): Promise<{
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly revocationEndpoint?: string;
}> {
  const fetchImpl = runtime.fetch ?? fetch;
  const url = issuer.endsWith('/')
    ? `${issuer}.well-known/oauth-authorization-server`
    : `${issuer}/.well-known/oauth-authorization-server`;
  try {
    const response = await fetchImpl(url);
    const body = await readJson(response);
    if (body === null) {
      return {};
    }
    const discovered: {
      readonly authorizationEndpoint?: string;
      readonly tokenEndpoint?: string;
      readonly revocationEndpoint?: string;
    } = compact({
      authorizationEndpoint:
        typeof body.device_authorization_endpoint === 'string'
          ? body.device_authorization_endpoint
          : undefined,
      tokenEndpoint:
        typeof body.token_endpoint === 'string'
          ? body.token_endpoint
          : undefined,
      revocationEndpoint:
        typeof body.revocation_endpoint === 'string'
          ? body.revocation_endpoint
          : undefined,
    });
    return discovered;
  } catch {
    return {};
  }
}

function parseAuthorization(
  body: Record<string, unknown>,
): DeviceAuthorization | null {
  if (
    typeof body.device_code !== 'string' ||
    typeof body.user_code !== 'string' ||
    typeof body.verification_uri !== 'string' ||
    typeof body.expires_in !== 'number'
  ) {
    return null;
  }
  return compact<DeviceAuthorization>({
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    verification_uri_complete:
      typeof body.verification_uri_complete === 'string'
        ? body.verification_uri_complete
        : undefined,
    expires_in: body.expires_in,
    interval: typeof body.interval === 'number' ? body.interval : undefined,
  });
}

type ParsedToken =
  | { readonly ok: true; readonly credential: StoredCredential }
  | { readonly ok: false; readonly error: string };

function parseToken(body: Record<string, unknown>, now: number): ParsedToken {
  if (typeof body.error === 'string') {
    return { ok: false, error: body.error };
  }
  if (typeof body.access_token !== 'string') {
    return { ok: false, error: 'invalid-token' };
  }
  return {
    ok: true,
    credential: compact<StoredCredential>({
      access_token: body.access_token,
      refresh_token:
        typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
      expires_at:
        typeof body.expires_in === 'number' ? now + body.expires_in : undefined,
      token_type:
        typeof body.token_type === 'string' ? body.token_type : undefined,
    }),
  };
}

export async function runDeviceFlow(
  device: DeviceFlowOptions,
  runtime: TerminalRuntime,
  write: (text: string) => void,
): Promise<StoredCredential | null> {
  const fetchImpl = runtime.fetch ?? fetch;
  const sleep = runtime.sleep ?? defaultSleep;
  const now = runtime.now ?? ((): number => Math.floor(Date.now() / 1000));
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
  const started = await fetchImpl(authorizationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: device.clientId,
      scope: device.scope ?? '',
    }),
  });
  const startedBody = await readJson(started);
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
    const polled = await fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: authorization.device_code,
        client_id: device.clientId,
      }),
    });
    const polledBody = await readJson(polled);
    if (polledBody === null) {
      return null;
    }
    const token = parseToken(polledBody, now());
    if (token.ok) {
      return token.credential;
    }
    if (token.error === 'slow_down') {
      interval += 5;
      continue;
    }
    if (token.error === 'authorization_pending') {
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
  const fetchImpl = runtime.fetch ?? fetch;
  const now = runtime.now ?? ((): number => Math.floor(Date.now() / 1000));
  let tokenEndpoint = device.tokenEndpoint;
  if (tokenEndpoint === undefined && device.issuer !== undefined) {
    tokenEndpoint = (await discoverDeviceEndpoints(device.issuer, runtime))
      .tokenEndpoint;
  }
  if (tokenEndpoint === undefined) {
    return null;
  }
  try {
    const response = await fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credential.refresh_token,
        client_id: device.clientId,
      }),
    });
    const body = await readJson(response);
    if (body === null) {
      return null;
    }
    const token = parseToken(body, now());
    return token.ok ? token.credential : null;
  } catch {
    return null;
  }
}

export async function revokeCredential(
  device: DeviceFlowOptions | undefined,
  credential: StoredCredential,
  runtime: TerminalRuntime,
): Promise<void> {
  if (device === undefined || credential.refresh_token === undefined) {
    return;
  }
  const fetchImpl = runtime.fetch ?? fetch;
  let revocationEndpoint = device.revocationEndpoint;
  if (revocationEndpoint === undefined && device.issuer !== undefined) {
    revocationEndpoint = (await discoverDeviceEndpoints(device.issuer, runtime))
      .revocationEndpoint;
  }
  if (revocationEndpoint === undefined) {
    return;
  }
  try {
    await fetchImpl(revocationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: credential.refresh_token,
        token_type_hint: 'refresh_token',
        client_id: device.clientId,
      }),
    });
  } catch {
    // ignore
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
