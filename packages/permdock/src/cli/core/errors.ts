import { stripVTControlCharacters } from "node:util";

import type { NextStep } from "./result.ts";

/**
 * 0 success, 1 failure, 2 usage, 3 action required, 130 interrupted (SIGINT or
 * a cancelled prompt), 143 terminated (SIGTERM).
 */
export type ExitCode = 0 | 1 | 2 | 3 | 130 | 143;

/**
 * `usage`: a flag, config or definition module the command cannot use (exit 2).
 * `unavailable`: a database or service the command needs did not answer (exit
 * 1). `failed`: the check the command ran found a problem, such as catalog
 * drift (exit 1). `action`: the run needs input, consent or a login it cannot
 * get without a person (exit 3). `cancelled`: the person at the terminal
 * cancelled a prompt (exit 130). `internal`: the CLI itself failed (exit 1).
 */
export type CliErrorKind =
  | "usage"
  | "unavailable"
  | "failed"
  | "action"
  | "cancelled"
  | "internal";

/**
 * The stable, snake_case `code` member of a CLI problem. A code better-supabase
 * also uses keeps its spelling, title and exit code there; the rest are
 * PermDock's own and never reuse one of its names for another meaning.
 */
export type ProblemCode =
  | "usage"
  | "unknown_command"
  | "unknown_flag"
  | "invalid_value"
  | "command_moved"
  | "flag_renamed"
  | "missing_value"
  | "config_not_found"
  | "config_invalid"
  | "dependency_missing"
  | "database_unreachable"
  | "network_error"
  | "request_failed"
  | "auth_required"
  | "dirty_worktree"
  | "write_failed"
  | "check_failed"
  | "catalog_invalid"
  | "input_required"
  | "consent_required"
  | "cancelled"
  | "internal";

const CODES: {
  readonly [K in ProblemCode]: readonly [title: string, exitCode: ExitCode];
} = {
  usage: ["Invalid arguments", 2],
  unknown_command: ["Unknown command", 2],
  unknown_flag: ["Unknown flag", 2],
  invalid_value: ["Invalid value", 2],
  command_moved: ["Command moved", 2],
  flag_renamed: ["Flag renamed", 2],
  missing_value: ["Missing value", 2],
  config_not_found: ["Config file not found", 2],
  config_invalid: ["Invalid config", 2],
  dependency_missing: ["Missing dependency", 1],
  database_unreachable: ["Database unreachable", 1],
  network_error: ["No response", 1],
  request_failed: ["Request failed", 1],
  auth_required: ["Authentication required", 3],
  dirty_worktree: ["Uncommitted changes", 3],
  write_failed: ["Write failed", 1],
  check_failed: ["Out of date", 1],
  catalog_invalid: ["Invalid catalog", 1],
  input_required: ["Input required", 3],
  consent_required: ["Consent required", 3],
  cancelled: ["Cancelled", 130],
  internal: ["Unexpected error", 1],
};

/** Every problem code, in the order the errors page lists them. */
export const PROBLEM_CODES: readonly ProblemCode[] = Object.keys(CODES).filter(
  (code): code is ProblemCode => code in CODES,
);

/** Each code has a heading on this page, so `type` links to its explanation. */
export const CLI_ERRORS_URL = "https://permdock.com/docs/cli/errors";

/** The exit code a problem with `code` gets. */
export function exitCodeOfProblem(code: ProblemCode): ExitCode {
  return CODES[code][1];
}

const DEFAULT_CODES: Readonly<Record<CliErrorKind, ProblemCode>> = {
  usage: "usage",
  unavailable: "network_error",
  failed: "check_failed",
  action: "input_required",
  cancelled: "cancelled",
  internal: "internal",
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

/**
 * RFC 9457 Problem Details for a run that failed, as `error` in the result
 * envelope.
 */
export type CliProblem = {
  readonly type: string;
  readonly title: string;
  readonly detail: string;
  readonly code: ProblemCode;
  readonly command?: string;
  readonly exitCode: ExitCode;
  readonly [extension: string]: unknown;
};

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The exit code an error ends the run with: its code's, so a `CliError` and the
 * problem printed for it always agree. Anything that is not a `CliError` is a
 * bug in the CLI.
 */
export function exitCodeOfError(error: unknown): ExitCode {
  if (error instanceof CliError) {
    return exitCodeOfProblem(error.code);
  }
  return rejectedDefinition(error)
    ? exitCodeOfProblem("config_invalid")
    : exitCodeOf("internal");
}

/**
 * The library's own runtime checks throw plain errors whose message starts with
 * `PermDock` (an identifier, a condition, a policy it rejects). Those are the
 * project's to fix, so they count as `config_invalid`, not as a CLI bug.
 */
function rejectedDefinition(error: unknown): error is Error {
  return error instanceof Error && /^PermDock( CLI)?[:\s]/u.test(error.message);
}

export function exitCodeOf(kind: CliErrorKind): ExitCode {
  switch (kind) {
    case "usage":
      return 2;
    case "unavailable":
    case "failed":
    case "internal":
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
    /** The exit code the run ended with, when it is not the code's own (143). */
    readonly exitCode?: ExitCode;
  },
): CliProblem {
  const code = options?.code ?? DEFAULT_CODES[kind];
  const [title, exitCode] = CODES[code];
  return {
    ...options?.extensions,
    type: `${CLI_ERRORS_URL}#${code}`,
    title,
    detail: stripVTControlCharacters(message),
    code,
    ...(command === undefined ? {} : { command }),
    exitCode: options?.exitCode ?? exitCode,
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
  return rejectedDefinition(error)
    ? cliProblem("usage", error.message, command, { code: "config_invalid" })
    : cliProblem("internal", describeError(error), command);
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
  return { code: 2, output: describeError(error) };
}

/**
 * A config, policy or definition the command cannot compile: the project's to
 * fix, so a usage error (exit 2) and never an `internal` one.
 */
export function configError(message: string): CliError {
  return new CliError("usage", message, { code: "config_invalid" });
}

/**
 * The run needs a value only the caller can supply: exit 3 with `missing`
 * naming the flags.
 */
export function missingInput(
  command: string,
  missing: readonly string[],
  hint?: string,
): CliError {
  return new CliError(
    "action",
    `${command} needs ${missing.join(" and ")}${hint === undefined ? "" : `: ${hint}`}`,
    { code: "input_required", extensions: { missing } },
  );
}
