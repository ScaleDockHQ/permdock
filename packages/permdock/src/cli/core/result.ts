import type { ExitCode, ProblemCode } from "./errors.ts";

/**
 * A next step for an agent or a script: the full command line, and when to run
 * it.
 */
export type NextStep = { readonly command: string; readonly when: string };

/** One finding a check reports, rendered as text, GitHub annotations or SARIF. */
export type Finding = {
  readonly code: string;
  /** Names this one finding across runs, so a baseline can accept it. */
  readonly id?: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly fix?: string;
  readonly file?: string;
  readonly line?: number;
  /** The docs page that explains the finding. */
  readonly docs?: string;
};

/**
 * What a command returns. `output` is the human report on stdout. `data` is the
 * typed result `--json` prints; without it `--json` reads `output` as JSON when
 * it parses. A run that exits 1 with a report prints it on stdout; any other
 * failure prints the error document on stderr, with `data` as its details.
 */
export type CommandResult = {
  readonly code: ExitCode;
  readonly output: string;
  readonly data?: unknown;
  /** Why the run failed, the error document's `reason`; a report sets none. */
  readonly reason?: ProblemCode;
  /** The commands to run after a success, as the envelope's `next`. */
  readonly next?: readonly NextStep[];
  readonly findings?: readonly Finding[];
  /** The command wrote its own NDJSON events on stdout; print nothing more. */
  readonly streamed?: boolean;
};
