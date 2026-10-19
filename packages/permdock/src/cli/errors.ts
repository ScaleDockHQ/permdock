import { stripVTControlCharacters } from "node:util";

/**
 * 0 success, 1 failure, 2 usage, 3 action required, 130 interrupted (SIGINT
 * or a cancelled prompt), 143 terminated (SIGTERM).
 */
export type ExitCode = 0 | 1 | 2 | 3 | 130 | 143;

/**
 * `usage`: a flag, config or definition module the command cannot use (exit
 * 2). `unavailable`: a database or service the command needs did not answer
 * (exit 1, like the Cloud being unreachable). `failed`: the check the command
 * ran found a problem, such as catalog drift (exit 1). `cancelled`: the person
 * at the terminal cancelled a prompt (exit 130).
 */
export type CliErrorKind = "usage" | "unavailable" | "failed" | "cancelled";

export class CliError extends Error {
  public readonly kind: CliErrorKind;

  public constructor(
    kind: CliErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CliError";
    this.kind = kind;
  }
}

/** RFC 9457 Problem Details for a command that failed, printed on stdout under `--json`. */
export type CliProblem = {
  readonly type: string;
  readonly title: string;
  readonly detail: string;
  readonly command?: string;
  readonly exitCode: ExitCode;
};

const TITLES: Readonly<Record<CliErrorKind, string>> = {
  usage: "Usage or configuration error",
  unavailable: "A database or service the command needs did not answer",
  failed: "The check the command ran found a problem",
  cancelled: "The command was cancelled",
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
    case "cancelled":
      return 130;
    default: {
      const never: never = kind;
      return never;
    }
  }
}

export function cliProblem(
  kind: CliErrorKind,
  message: string,
  command: string | undefined,
): CliProblem {
  return {
    type: `https://permdock.com/problems/cli-${kind}`,
    title: TITLES[kind],
    detail: stripVTControlCharacters(message),
    ...(command === undefined ? {} : { command }),
    exitCode: exitCodeOf(kind),
  };
}

/**
 * The result a command reports for a usage error it caught. A `CliError`
 * propagates instead, so `run()` prints it, as Problem Details under `--json`.
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
