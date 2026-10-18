import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import type {
  StoredCredential,
  TerminalRuntime,
} from "../../terminal/types.ts";

import { secondsAt } from "../../core/time.ts";
import { parseToken, postForm } from "../../terminal/device.ts";

/** How long the loopback listener waits for the browser to come back. */
const LOOPBACK_TIMEOUT_MS = 5 * 60_000;

export type LoopbackOptions = {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly scope: string;
  readonly write: (text: string) => void;
  readonly open?: (url: string) => void;
  readonly timeoutMs?: number;
};

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(
        typeof address === "object" && address !== null ? address.port : 0,
      );
    });
  });
}

type Callback =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly error: string };

/**
 * RFC 8252 native-app login: an authorization code delivered to a listener on
 * `127.0.0.1` with an ephemeral port, bound by PKCE S256 (RFC 7636) and a
 * `state` that the callback must echo.
 */
export async function runLoopbackFlow(
  options: LoopbackOptions,
  runtime: TerminalRuntime,
): Promise<StoredCredential | null> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));
  const { promise: callback, resolve: settle } =
    Promise.withResolvers<Callback>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const ok = url.searchParams.get("state") === state && code !== null;
    response
      .writeHead(ok ? 200 : 400, {
        "content-type": "text/plain; charset=utf-8",
      })
      .end(
        ok
          ? "PermDock login complete. You can close this tab.\n"
          : "PermDock login failed. Return to the terminal.\n",
      );
    settle(
      ok ? { ok: true, code } : { ok: false, error: error ?? "state-mismatch" },
    );
  });
  let port: number;
  try {
    port = await listen(server);
  } catch {
    return null;
  }
  const redirectUri = `http://127.0.0.1:${String(port)}/callback`;
  const authorize = new URL(options.authorizationEndpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", options.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", options.scope);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  options.write(`Open ${authorize.href} to log in\n`);
  options.open?.(authorize.href);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Callback>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, error: "timeout" });
    }, options.timeoutMs ?? LOOPBACK_TIMEOUT_MS);
  });
  const result = await Promise.race([callback, timeout]);
  clearTimeout(timer);
  server.closeAllConnections();
  server.close();
  if (!result.ok) {
    return null;
  }
  const body = await postForm(runtime, options.tokenEndpoint, {
    grant_type: "authorization_code",
    code: result.code,
    redirect_uri: redirectUri,
    client_id: options.clientId,
    code_verifier: verifier,
  });
  if (body === null) {
    return null;
  }
  const token = parseToken(body, secondsAt(runtime.now?.()));
  return token.ok ? token.credential : null;
}
