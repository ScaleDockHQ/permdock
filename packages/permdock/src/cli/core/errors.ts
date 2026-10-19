import { stripVTControlCharacters } from "node:util";

import type { NextStep } from "./result.ts";

/**
 * 0 success, 1 failure, 2 usage, 3 action required, 130 interrupted (SIGINT
 * or a cancelled prompt), 143 terminated (SIGTERM).
 */
export type ExitCode = 0 | 1 | 2 | 3 | 130 | 143;

/**
 * `usage`: a flag, config or definition module the command cannot use (exit
 * 2). `unavailable`: a database or service the command needs did not answer
 * (exit 1). `failed`: the check the command ran found a problem, such as
 * catalog drift (exit 1). `action`: the run needs input, consent or a login
 * it cannot get without a person (exit 3). `cancelled`: the person at the
 * terminal cancelled a prompt (exit 130).
 */
export type CliErrorKind =
  | "usage"
  | "unavailable"
  | "failed"
  | "action"
  | "cancelled";

/** The stable, snake_case `code` member of a CLI problem; the contract better-supabase shares. */
export type ProblemCode =
  | "usage_error"
  | "unknown_command"
  | "unknown_flag"
  | "invalid_value"
  | "command_moved"
  | "flag_renamed"
  | "missing_input"
  | "missing_config"
  | "peer_missing"
  | "supabase_cli_missing"
  | "file_conflict"
  | "consent_required"
  | "auth_required"
  | "network_error"
  | "database_unavailable"
  | "service_unavailable"
  | "check_failed"
  | "cancelled";

const DEFAULT_CODES: Readonly<Record<CliErrorKind, ProblemCode>> = {
  usage: "usage_error",
  unavailable: "service_unavailable",
  failed: "check_failed",
  action: "missing_input",
  cancelled: "cancelled",
};

export type CliErrorOptions = ErrorOptions & {
  readonly code?: ProblemCode;
  /** Problem Details extension members, such as `missing` or `choices`. */
  readonly extensions?: Readonly<Record<string, unknown>>;
  /** Commands that resolve the problem, printed after it and sent as `next`. */
  readonly next?: readonly NextStep[];
};

export class CliError extends Error {
  public readonly kind: CliErrorKind;
  public readonly code: ProblemCode;
  public readonly extensions: Readonly<Record<string, unknown>>;
  public readonly next: readonly NextStep[] | undefined;

  public constructor(
    kind: CliErrorKind,
    message: string,
    options?: CliErrorOptions,
  ) {
    super(message, options);
    this.name = "CliError";
    this.kind = kind;
    this.code = options?.code ?? DEFAULT_CODES[kind];
    this.extensions = options?.extensions ?? {};
    this.next = options?.next;
  }
}

/** RFC 9457 Problem Details for a run that failed, as `error` in the result envelope. */
export type CliProblem = {
  readonly type: string;
  readonly title: string;
  readonly detail: string;
  readonly code: ProblemCode;
  readonly command?: string;
  readonly exitCode: ExitCode;
  readonly [extension: string]: unknown;
};

const TITLES: Readonly<Record<CliErrorKind, string>> = {
  usage: "Usage or configuration error",
  unavailable: "A database or service the command needs did not answer",
  failed: "The check the command ran found a problem",
  action: "The command needs input, consent or a login to continue",
  cancelled: "The command was cancelled",
};

const TYPES: Readonly<Record<CliErrorKind, string>> = {
  usage: "cli-usage",
  unavailable: "cli-unavailable",
  failed: "cli-failed",
  action: "cli-action-required",
  cancelled: "cli-cancelled",
};

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An unclassified error is a usage error: a module that throws while loading is the project's to fix. */
export function cliErrorKind(error: unknown): CliErrorKind {
  return error instanceof CliError ? error.kind : "usage";
}

export function exitCodeOf(kind: CliErrorKind): ExitCode {
  switch (kind) {
    case "usage":
      return 2;
    case "unavailable":
    case "failed":
      return 1;
    case "action":
      return 3;
    case "cancelled":
      return 130;
    default: {
      const never: never = kind;
      return never;
    }
  }
}

export function kindOfCode(code: ExitCode): CliErrorKind {
  switch (code) {
    case 2:
      return "usage";
    case 3:
      return "action";
    case 130:
    case 143:
      return "cancelled";
    case 0:
    case 1:
      return "failed";
    default: {
      const never: never = code;
      return never;
    }
  }
}

export function cliProblem(
  kind: CliErrorKind,
  message: string,
  command: string | undefined,
  options?: {
    readonly code?: ProblemCode;
    readonly extensions?: Readonly<Record<string, unknown>>;
  },
): CliProblem {
  return {
    ...options?.extensions,
    type: `https://permdock.com/problems/${TYPES[kind]}`,
    title: TITLES[kind],
    detail: stripVTControlCharacters(message),
    code: options?.code ?? DEFAULT_CODES[kind],
    ...(command === undefined ? {} : { command }),
    exitCode: exitCodeOf(kind),
  };
}

export function problemOf(
  error: unknown,
  command: string | undefined,
): CliProblem {
  if (error instanceof CliError) {
    return cliProblem(error.kind, error.message, command, {
      code: error.code,
      extensions: error.extensions,
    });
  }
  return cliProblem("usage", describeError(error), command);
}

/**
 * The result a command reports for a usage error it caught. A `CliError`
 * propagates instead, so `run()` prints it as Problem Details.
 */
export function usageResult(error: unknown): {
  readonly code: 2;
  readonly output: string;
} {
  if (error instanceof CliError) {
    throw error;
  }
  return {
    code: 2,
    output: describeError(error),
  };
}

/** The run needs a value only the caller can supply: exit 3 with `missing` naming the flags. */
export function missingInput(
  command: string,
  missing: readonly string[],
  hint?: string,
): CliError {
  return new CliError(
    "action",
    `${command} needs ${missing.join(" and ")}${hint === undefined ? "" : `: ${hint}`}`,
    { code: "missing_input", extensions: { missing } },
  );
}
