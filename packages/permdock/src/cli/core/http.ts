import type { CliIo } from "../types.ts";

import { timeoutSignal } from "../../core/timeout.ts";
import { TERMINAL_TIMEOUT_MS } from "../../terminal/device.ts";
import { CliError, describeError } from "./errors.ts";
import { cliVersion } from "./version.ts";

/**
 * `permdock-cli/<version> node/<version> <platform>`, sent on every request the
 * CLI makes.
 */
function userAgent(): string {
  return `permdock-cli/${cliVersion()} node/${process.versions.node} ${process.platform}`;
}

export type HttpRequest = {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | URLSearchParams;
  /** What the request reaches, for the error message: `PermDock Cloud`. */
  readonly service: string;
  readonly timeoutMs?: number;
};

/**
 * Every outbound request: the user agent, a timeout joined to the run's abort
 * signal, and a `network_error` CLI error when nothing answers.
 */
export async function httpRequest(
  io: Pick<CliIo, "fetch" | "signal">,
  request: HttpRequest,
): Promise<Response> {
  const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    return await fetchImpl(request.url, {
      method: request.method ?? "GET",
      headers: { "user-agent": userAgent(), ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: timeoutSignal(
        request.timeoutMs ?? TERMINAL_TIMEOUT_MS,
        io.signal,
      ),
    });
  } catch (error) {
    throw new CliError(
      "unavailable",
      `${request.service} unreachable: ${describeError(error)}`,
      { code: "network_error", cause: error },
    );
  }
}

/**
 * A 401 or 403 as an `auth_required` action: the credential is missing, expired
 * or lacks a scope, and `next` says how to get one.
 */
export function authFailure(
  response: Response,
  message: string,
  next: readonly { readonly command: string; readonly when: string }[],
): CliError | undefined {
  if (response.status !== 401 && response.status !== 403) {
    return undefined;
  }
  return new CliError(
    "action",
    `${message} (HTTP ${String(response.status)})`,
    { code: "auth_required", extensions: { status: response.status }, next },
  );
}
