import type { TerminalRuntime } from "../../terminal/types.ts";

import {
  discoverAuthorizationServer,
  stringField,
} from "../../terminal/device.ts";

/** The PermDock Cloud platform issuer and API base. */
const PLATFORM_ISSUER = "https://permdock.com/api";

/** The public OAuth client the `permdock` binary registers as. */
export const CLI_CLIENT_ID = "permdock-cli";

export const READ_SCOPES = ["projects:read", "policy:read"] as const;
export const WRITE_SCOPE = "catalog:write";

export type Env = Readonly<Record<string, string | undefined>>;

export type IssuerMetadata = {
  readonly issuer: string;
  readonly authorizationEndpoint?: string;
  readonly deviceAuthorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly revocationEndpoint?: string;
  readonly registrationEndpoint?: string;
};

export function firstNonEmpty(
  ...values: readonly (string | undefined)[]
): string {
  for (const value of values) {
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return "";
}

/** `--url`, then `PERMDOCK_CLOUD_URL`, then the platform issuer; never a trailing slash. */
export function cloudUrl(flag: string | undefined, env: Env): string {
  return firstNonEmpty(
    flag,
    env["PERMDOCK_CLOUD_URL"],
    PLATFORM_ISSUER,
  ).replace(/\/+$/u, "");
}

export async function issuerMetadata(
  issuer: string,
  runtime: TerminalRuntime,
): Promise<IssuerMetadata | null> {
  const body = await discoverAuthorizationServer(issuer, runtime);
  if (body === null) {
    return null;
  }
  const endpoint = (name: string): string | undefined => {
    const value = stringField(body, name);
    return value !== undefined && isHttps(value, issuer) ? value : undefined;
  };
  return {
    issuer,
    ...optional("authorizationEndpoint", endpoint("authorization_endpoint")),
    ...optional(
      "deviceAuthorizationEndpoint",
      endpoint("device_authorization_endpoint"),
    ),
    ...optional("tokenEndpoint", endpoint("token_endpoint")),
    ...optional("revocationEndpoint", endpoint("revocation_endpoint")),
    ...optional("registrationEndpoint", endpoint("registration_endpoint")),
  };
}

function optional<K extends string>(
  key: K,
  value: string | undefined,
): { readonly [P in K]?: string } {
  // SAFETY: a one-key object whose key is K; empty when the value is absent.
  return (value === undefined ? {} : { [key]: value }) as {
    readonly [P in K]?: string;
  };
}

/**
 * An endpoint must be `https:`, except on a loopback issuer, which a local
 * Cloud serves over plain HTTP.
 */
function isHttps(value: string, issuer: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") {
      return true;
    }
    const host = new URL(issuer).hostname;
    return (
      url.protocol === "http:" &&
      (host === "localhost" || host === "127.0.0.1" || host === "[::1]")
    );
  } catch {
    return false;
  }
}
