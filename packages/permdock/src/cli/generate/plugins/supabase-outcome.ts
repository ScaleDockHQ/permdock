import type { NotedFiles } from "../plugin.ts";

import { CliError } from "../../core/errors.ts";
import { noted } from "../plugin.ts";

/** The notes of a `runSupabase` outcome, or the error it reports. */
export function outcomeNotes(outcome: {
  readonly code: number;
  readonly output: string;
}): NotedFiles {
  if (outcome.code !== 0) {
    throw new CliError(
      outcome.code === 2 ? "usage" : "failed",
      outcome.output,
      { code: outcome.code === 2 ? "config_invalid" : "check_failed" },
    );
  }
  return noted([], outcome.output === "" ? [] : outcome.output.split("\n"));
}
