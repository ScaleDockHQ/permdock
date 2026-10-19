import { spawn } from "node:child_process";

import type {
  StoredCredential,
  TerminalRuntime,
} from "../../terminal/types.ts";
import type { CommandResult } from "../shared/result.ts";
import type { CliIo } from "../types.ts";

import { timeoutSignal } from "../../core/timeout.ts";
import { runDeviceFlow, TERMINAL_TIMEOUT_MS } from "../../terminal/device.ts";
import {
  credentialsPath,
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from "../../terminal/storage.ts";
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
  WRITE_SCOPE,
} from "./issuer.ts";
import { runLoopbackFlow } from "./loopback.ts";

export type LoginInput = {
  readonly cwd: string;
  readonly url: string | undefined;
  readonly loopback: boolean;
  readonly write: boolean;
  readonly open: boolean;
  readonly json: boolean;
  readonly env: Env;
  readonly io: CliIo;
};

/** Opens `url` in the default browser; a failure leaves the printed URL to the user. */
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
  const fetchImpl = runtime.fetch ?? fetch;
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
      signal: timeoutSignal(TERMINAL_TIMEOUT_MS),
    });
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
  const scope = [...READ_SCOPES, ...(input.write ? [WRITE_SCOPE] : [])].join(
    " ",
  );
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

/** Revokes the stored login (RFC 7009) and deletes it; a revocation failure still deletes it. */
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
