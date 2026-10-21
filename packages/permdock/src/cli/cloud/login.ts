import { spawn } from "node:child_process";

import type {
  StoredCredential,
  TerminalRuntime,
} from "../../terminal/types.ts";
import type { CommandResult } from "../core/result.ts";
import type { CliIo } from "../types.ts";

import { dateAt, instantAt, secondsAt } from "../../core/time.ts";
import { runDeviceFlow } from "../../terminal/device.ts";
import {
  credentialsPath,
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from "../../terminal/storage.ts";
import { CliError } from "../core/errors.ts";
import { httpRequest } from "../core/http.ts";
import {
  CREDENTIAL_SERVICE,
  cliRuntime,
  credentialStorage,
  credentialsInsideRepository,
} from "./auth.ts";
import {
  CLI_CLIENT_ID,
  cloudUrl,
  type Env,
  issuerMetadata,
  READ_SCOPES,
} from "./issuer.ts";
import { runLoopbackFlow } from "./loopback.ts";

export type LoginInput = {
  readonly cwd: string;
  readonly url: string | undefined;
  readonly loopback: boolean;
  /** Scopes beyond the read scopes, such as `catalog:write`. */
  readonly scopes: readonly string[];
  readonly open: boolean;
  readonly json: boolean;
  readonly env: Env;
  readonly io: CliIo;
};

/**
 * Opens `url` in the default browser; a failure leaves the printed URL to the
 * user.
 */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // No browser launcher: the URL is already on stderr.
  }
}

/** RFC 7009 answers 200 with an empty body, also for a token it does not know. */
async function revoke(
  runtime: TerminalRuntime,
  endpoint: string,
  fields: Record<string, string>,
): Promise<boolean> {
  try {
    const response = await httpRequest(
      runtime.fetch === undefined ? {} : { fetch: runtime.fetch },
      {
        url: endpoint,
        method: "POST",
        service: endpoint,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

function failed(code: 1 | 2, output: string): CommandResult {
  return { code, output };
}

export async function runLogin(input: LoginInput): Promise<CommandResult> {
  const issuer = cloudUrl(input.url, input.env);
  const runtime = cliRuntime(input.io, input.env);
  const inside = credentialsInsideRepository(input.cwd, runtime);
  if (inside !== null) {
    return failed(
      2,
      `permdock login refuses to store credentials inside the repository (${inside}); point XDG_CONFIG_HOME outside it`,
    );
  }
  const metadata = await issuerMetadata(issuer, runtime);
  if (metadata === null) {
    return failed(
      1,
      `permdock login: ${issuer} publishes no RFC 8414 metadata for that issuer`,
    );
  }
  const scope = [...new Set([...READ_SCOPES, ...input.scopes])].join(" ");
  const open = input.open ? openBrowser : undefined;
  const say = (text: string): void => {
    input.io.stderr(text.replace(/\n$/u, ""));
  };
  let credential: StoredCredential | null = null;
  if (
    !input.loopback &&
    metadata.deviceAuthorizationEndpoint !== undefined &&
    metadata.tokenEndpoint !== undefined
  ) {
    credential = await runDeviceFlow(
      {
        clientId: CLI_CLIENT_ID,
        scope,
        authorizationEndpoint: metadata.deviceAuthorizationEndpoint,
        tokenEndpoint: metadata.tokenEndpoint,
        ...(open === undefined ? {} : { open }),
      },
      runtime,
      say,
    );
  } else if (
    metadata.authorizationEndpoint !== undefined &&
    metadata.tokenEndpoint !== undefined
  ) {
    credential = await runLoopbackFlow(
      {
        authorizationEndpoint: metadata.authorizationEndpoint,
        tokenEndpoint: metadata.tokenEndpoint,
        clientId: CLI_CLIENT_ID,
        scope,
        write: say,
        ...(open === undefined ? {} : { open }),
      },
      runtime,
    );
  } else {
    return failed(
      1,
      `permdock login: ${issuer} offers neither the device flow nor an authorization endpoint`,
    );
  }
  if (credential === null) {
    return failed(1, `permdock login: ${issuer} did not issue a token`);
  }
  const granted: StoredCredential =
    credential.scope === undefined ? { ...credential, scope } : credential;
  const storage = await credentialStorage();
  const where =
    writeCredentials(storage, issuer, granted, runtime) === "keychain"
      ? "the OS keychain"
      : credentialsPath(CREDENTIAL_SERVICE, runtime);
  return {
    code: 0,
    output: input.json
      ? JSON.stringify({ issuer, scope: granted.scope, storage: where })
      : `logged in to ${issuer} (${granted.scope ?? scope}); credentials in ${where}`,
  };
}

export type LogoutInput = {
  readonly url: string | undefined;
  readonly json: boolean;
  readonly env: Env;
  readonly io: CliIo;
};

/**
 * Revokes the stored login (RFC 7009) and deletes it; a revocation failure
 * still deletes it.
 */
export async function runLogout(input: LogoutInput): Promise<CommandResult> {
  const issuer = cloudUrl(input.url, input.env);
  const runtime = cliRuntime(input.io, input.env);
  const storage = await credentialStorage();
  const credential = readCredentials(storage, issuer, runtime);
  if (credential === null) {
    return {
      code: 0,
      output: input.json
        ? JSON.stringify({ issuer, status: "not logged in" })
        : `not logged in to ${issuer}`,
    };
  }
  const metadata = await issuerMetadata(issuer, runtime);
  let revoked = false;
  if (metadata?.revocationEndpoint !== undefined) {
    const refresh = credential.refresh_token;
    revoked = await revoke(runtime, metadata.revocationEndpoint, {
      token: refresh ?? credential.access_token,
      token_type_hint: refresh === undefined ? "access_token" : "refresh_token",
      client_id: CLI_CLIENT_ID,
    });
  }
  deleteCredentials(storage, issuer, runtime);
  const status = revoked ? "revoked" : "deleted";
  return {
    code: 0,
    output: input.json
      ? JSON.stringify({ issuer, status })
      : `logged out of ${issuer} (${revoked ? "token revoked" : "credentials deleted; the token was not revoked"})`,
  };
}

export type WhoamiInput = {
  readonly url: string | undefined;
  readonly json: boolean;
  readonly env: Env;
  readonly io: CliIo;
};

/** The credential the next Cloud call sends, without sending it. */
export async function runWhoami(input: WhoamiInput): Promise<CommandResult> {
  const issuer = cloudUrl(input.url, input.env);
  for (const name of ["PERMDOCK_CLOUD_KEY", "PERMDOCK_CLOUD_TOKEN"] as const) {
    const value = input.env[name];
    if (value !== undefined && value !== "") {
      const data = { issuer, source: name };
      return {
        code: 0,
        output: input.json
          ? JSON.stringify(data)
          : `${issuer}: ${name} from the environment`,
        data,
      };
    }
  }
  const runtime = cliRuntime(input.io, input.env);
  const credential = readCredentials(
    await credentialStorage(),
    issuer,
    runtime,
  );
  if (credential === null) {
    throw new CliError("action", `not logged in to ${issuer}`, {
      code: "auth_required",
      next: [{ command: "permdock login", when: "to log in" }],
    });
  }
  const scopes = (credential.scope ?? "")
    .split(" ")
    .filter((scope) => scope !== "");
  const expired =
    credential.expires_at !== undefined &&
    credential.expires_at <= secondsAt(runtime.now?.()) &&
    credential.refresh_token === undefined;
  const data = {
    issuer,
    source: "login",
    scopes,
    ...(credential.expires_at === undefined
      ? {}
      : { expiresAt: dateAt(instantAt(credential.expires_at)).toISOString() }),
    expired,
  };
  return {
    code: 0,
    output: input.json
      ? JSON.stringify(data)
      : `${issuer}: logged in (${scopes.join(" ") || "no scopes"})${expired ? "; the login has expired, run permdock login" : ""}`,
    data,
  };
}
