import type { ExitCode } from "./errors.ts";

/** A next step for an agent or a script: the full command line, and when to run it. */
export type NextStep = {
  readonly command: string;
  readonly when: string;
};

/** One finding a check reports, rendered as text, GitHub annotations or SARIF. */
export type Finding = {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly fix?: string;
  readonly file?: string;
  readonly line?: number;
  /** The docs page that explains the finding. */
  readonly docs?: string;
};

/**
 * What a command returns. `output` is the human report on stdout. `data`
 * is the typed result the `--json` envelope carries; without it the
 * envelope reads `output` as JSON when it parses.
 */
export type CommandResult = {
  readonly code: ExitCode;
  readonly output: string;
  readonly data?: unknown;
  readonly findings?: readonly Finding[];
  /** The command wrote its own NDJSON events on stdout; print nothing more. */
  readonly streamed?: boolean;
};
