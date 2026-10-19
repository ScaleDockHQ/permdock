import type { ExitCode } from "../errors.ts";

/** What a command returns: the exit code and the text printed to stdout. */
export type CommandResult = {
  readonly code: ExitCode;
  readonly output: string;
};
