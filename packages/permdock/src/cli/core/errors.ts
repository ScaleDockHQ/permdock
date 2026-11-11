import { stripVTControlCharacters } from "node:util";

import type { NextStep } from "./result.ts";

/**
 * 0 success, 1 failure, 2 usage or an action only a person can take (an input,
 * a confirmation, a login), 130 interrupted (SIGINT or a cancelled prompt), 143
 * terminated (SIGTERM).
 */
export type ExitCode = 0 | 1 | 2 | 130 | 143;

/**
 * `usage`: a flag, config or definition module the command cannot use (exit 2).
 * `unavailable`: a database or service the command needs did not answer (exit
 * 1). `failed`: the command ran and failed, such as a write it could not make
 * (exit 1). `action`: the run needs input, a confirmation or a login it cannot
 * get without a person (exit 2). `cancelled`: the person at the terminal
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
 * Why a run failed: the error document's `reason`. Every code is one of
 * better-supabase's CLI contract 3 reasons, with its meaning and exit code.
 */
export type ProblemCode =
  | "usage"
  | "unknown_command"
  | "unknown_flag"
  | "invalid_value"
  | "flag_renamed"
  | "missing_value"
  | "config_not_found"
  | "config_invalid"
  | "invalid_input"
  | "dependency_missing"
  | "database_unreachable"
  | "network_error"
  | "request_failed"
  | "auth_required"
  | "check_failed"
  | "file_conflict"
  | "input_required"
  | "confirmation_required"
  | "cancelled"
  | "failed"
  | "internal";

const CODES: { readonly [K in ProblemCode]: ExitCode } = {
  usage: 2,
  unknown_command: 2,
  unknown_flag: 2,
  invalid_value: 2,
  flag_renamed: 2,
  missing_value: 2,
  config_not_found: 2,
  config_invalid: 2,
  invalid_input: 1,
  dependency_missing: 1,
  database_unreachable: 1,
  network_error: 1,
  request_failed: 1,
  auth_required: 2,
  check_failed: 1,
  file_conflict: 1,
  input_required: 2,
  confirmation_required: 2,
  cancelled: 130,
  failed: 1,
  internal: 1,
};

/** Every problem code, in the order the errors page lists them. */
export const PROBLEM_CODES: readonly ProblemCode[] = Object.keys(CODES).filter(
  (code): code is ProblemCode => code in CODES,
);

/** Each code has a heading on this page, so `type` links to its explanation. */
export const CLI_ERRORS_URL = "https://permdock.com/docs/cli/errors";

/** The exit code a problem with `code` gets. */
export function exitCodeOfProblem(code: ProblemCode): ExitCode {
  return CODES[code];
}

/** A person has to give an input, confirm or log in before a retry helps. */
export function isActionRequired(code: ProblemCode): boolean {
  return (
    code === "auth_required" ||
    code === "input_required" ||
    code === "confirmation_required"
  );
}

/** Running the same command again later can succeed. */
export function isRetryable(code: ProblemCode): boolean {
  return (
    code === "database_unreachable" ||
    code === "network_error" ||
    code === "request_failed"
  );
}

const DEFAULT_CODES: Readonly<Record<CliErrorKind, ProblemCode>> = {
  usage: "usage",
  unavailable: "network_error",
  failed: "failed",
  action: "input_required",
  cancelled: "cancelled",
  internal: "internal",
};

export type CliErrorOptions = ErrorOptions & {
  readonly code?: ProblemCode;
  /** Details of the failure, the error document's `data`: `missing`, `choices`. */
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

/** A run that failed, as the `--json` error document reports it. */
export type CliFailure = {
  readonly code: ProblemCode;
  readonly message: string;
  readonly exitCode: ExitCode;
  readonly data: Readonly<Record<string, unknown>>;
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
    case "action":
      return 2;
    case "unavailable":
    case "failed":
    case "internal":
      return 1;
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

export function cliFailure(
  kind: CliErrorKind,
  message: string,
  options?: {
    readonly code?: ProblemCode;
    readonly extensions?: Readonly<Record<string, unknown>>;
    /** The exit code the run ended with, when it is not the code's own (143). */
    readonly exitCode?: ExitCode;
  },
): CliFailure {
  const code = options?.code ?? DEFAULT_CODES[kind];
  return {
    code,
    message: stripVTControlCharacters(message),
    exitCode: options?.exitCode ?? CODES[code],
    data: options?.extensions ?? {},
  };
}

export function failureOf(error: unknown): CliFailure {
  if (error instanceof CliError) {
    return cliFailure(error.kind, error.message, {
      code: error.code,
      extensions: error.extensions,
    });
  }
  return rejectedDefinition(error)
    ? cliFailure("usage", error.message, { code: "config_invalid" })
    : cliFailure("internal", describeError(error));
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
 * The run needs a value only the caller can supply: exit 2 with `missing`
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
