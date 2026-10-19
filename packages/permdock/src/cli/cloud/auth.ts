import { existsSync } from "node:fs";
import path from "node:path";

import type {
  KeyringEntry,
  StoredCredential,
  TerminalRuntime,
  TerminalStorageOptions,
} from "../../terminal/types.ts";
import type { CliIo } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { secondsAt } from "../../core/time.ts";
import { refreshCredential } from "../../terminal/device.ts";
import {
  credentialsPath,
  readCredentials,
  writeCredentials,
} from "../../terminal/storage.ts";
import { CliError } from "../core/errors.ts";
import {
  CLI_CLIENT_ID,
  type Env,
  issuerMetadata,
  WRITE_SCOPE,
} from "./issuer.ts";

/** The service name credentials are stored under, in the keychain or the config directory. */
export const CREDENTIAL_SERVICE = "permdock";

/** Seconds before `expires_at` at which a stored access token counts as expired. */
const EXPIRY_SKEW_SECONDS = 30;

const KEYRING_PACKAGE = "@napi-rs/keyring";

export function cliRuntime(io: CliIo, env: Env): TerminalRuntime {
  const now = io.now;
  return {
    env,
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
    ...(now === undefined
      ? {}
      : { now: () => ({ epochMilliseconds: now().getTime() }) }),
  };
}

/**
 * `Entry` from the optional peer `@napi-rs/keyring` when the project installed
 * it; without it credentials go to the mode-0600 file.
 */
async function loadKeyring(): Promise<TerminalStorageOptions["keyring"]> {
  let loaded: unknown;
  try {
    // Optional peer: a variable specifier so neither TypeScript nor the bundler requires it.
    loaded = await import(KEYRING_PACKAGE);
  } catch {
    return undefined;
  }
  if (!isRecord(loaded) || typeof loaded["Entry"] !== "function") {
    return undefined;
  }
  // SAFETY: @napi-rs/keyring's Entry is `new (service, account)` with getPassword, setPassword and deletePassword.
  return loaded["Entry"] as new (
    service: string,
    account: string,
  ) => KeyringEntry;
}

export async function credentialStorage(): Promise<TerminalStorageOptions> {
  const keyring = await loadKeyring();
  return keyring === undefined
    ? { service: CREDENTIAL_SERVICE }
    : { service: CREDENTIAL_SERVICE, keyring };
}

/** The git work tree `cwd` sits in, or `null` outside one. */
function repositoryRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** The credentials file when it would land inside the repository at `cwd`; `null` when it is outside. */
export function credentialsInsideRepository(
  cwd: string,
  runtime: TerminalRuntime,
): string | null {
  const root = repositoryRoot(cwd);
  if (root === null) {
    return null;
  }
  const file = path.resolve(credentialsPath(CREDENTIAL_SERVICE, runtime));
  return file.startsWith(`${root}${path.sep}`) ? file : null;
}

function scopesOf(credential: StoredCredential): readonly string[] {
  return (credential.scope ?? "").split(" ").filter((scope) => scope !== "");
}

export type CloudAuth = {
  readonly bearer: string;
  readonly source: "PERMDOCK_CLOUD_TOKEN" | "PERMDOCK_CLOUD_KEY" | "login";
};

function authRequired(message: string, login: string, ci: string): CliError {
  return new CliError("action", message, {
    code: "auth_required",
    next: [
      { command: login, when: "to log in on this machine" },
      { command: ci, when: "in CI" },
    ],
  });
}

/** The stored login for `issuer`, refreshed when its access token has expired. */
async function storedLogin(
  issuer: string,
  runtime: TerminalRuntime,
): Promise<StoredCredential | "expired" | null> {
  const storage = await credentialStorage();
  const credential = readCredentials(storage, issuer, runtime);
  if (credential === null) {
    return null;
  }
  const now = secondsAt(runtime.now?.());
  if (
    credential.expires_at === undefined ||
    credential.expires_at - EXPIRY_SKEW_SECONDS > now
  ) {
    return credential;
  }
  const metadata = await issuerMetadata(issuer, runtime);
  const refreshed =
    metadata?.tokenEndpoint === undefined
      ? null
      : await refreshCredential(
          { clientId: CLI_CLIENT_ID, tokenEndpoint: metadata.tokenEndpoint },
          credential,
          runtime,
        );
  if (refreshed === null) {
    return "expired";
  }
  const kept: StoredCredential = {
    ...refreshed,
    ...(refreshed.refresh_token === undefined &&
    credential.refresh_token !== undefined
      ? { refresh_token: credential.refresh_token }
      : {}),
    ...(refreshed.scope === undefined && credential.scope !== undefined
      ? { scope: credential.scope }
      : {}),
  };
  writeCredentials(storage, issuer, kept, runtime);
  return kept;
}

/**
 * The bearer for the read API: `PERMDOCK_CLOUD_TOKEN` (a read-only key pinned
 * to one environment, for CI), then the stored login for `issuer`. Throws an
 * `auth_required` error when there is neither.
 */
export async function readAuth(
  command: string,
  issuer: string,
  env: Env,
  runtime: TerminalRuntime,
): Promise<CloudAuth> {
  const token = env["PERMDOCK_CLOUD_TOKEN"];
  if (token !== undefined && token !== "") {
    return { bearer: token, source: "PERMDOCK_CLOUD_TOKEN" };
  }
  const login = await storedLogin(issuer, runtime);
  if (login === "expired" || login === null) {
    throw authRequired(
      login === null
        ? `${command} needs a login: run permdock login, or set PERMDOCK_CLOUD_TOKEN in CI`
        : `${command}: the login for ${issuer} has expired; run permdock login`,
      "permdock login",
      "export PERMDOCK_CLOUD_TOKEN=<read-only key>",
    );
  }
  return { bearer: login.access_token, source: "login" };
}

/** The bearer for `cloud push`: `PERMDOCK_CLOUD_KEY`, then a login holding `catalog:write`. */
export async function pushAuth(
  issuer: string,
  env: Env,
  runtime: TerminalRuntime,
): Promise<CloudAuth> {
  const key = env["PERMDOCK_CLOUD_KEY"];
  if (key !== undefined && key !== "") {
    return { bearer: key, source: "PERMDOCK_CLOUD_KEY" };
  }
  const login = await storedLogin(issuer, runtime);
  if (
    login === "expired" ||
    login === null ||
    !scopesOf(login).includes(WRITE_SCOPE)
  ) {
    throw authRequired(
      login === "expired"
        ? `permdock cloud push: the login for ${issuer} has expired; run permdock login --scope ${WRITE_SCOPE}`
        : login === null
          ? `permdock cloud push needs PERMDOCK_CLOUD_KEY in the environment, or a login from permdock login --scope ${WRITE_SCOPE}`
          : `permdock cloud push needs ${WRITE_SCOPE}: run permdock login --scope ${WRITE_SCOPE}`,
      `permdock login --scope ${WRITE_SCOPE}`,
      "export PERMDOCK_CLOUD_KEY=<write key>",
    );
  }
  return { bearer: login.access_token, source: "login" };
}
