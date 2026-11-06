import type { CliContext } from "../../src/cli/core/context.ts";
import type { CliIo, RunResult } from "../../src/cli/types.ts";

import { rlsGenerateFromFlags } from "../../src/cli/commands/rls.ts";
import { CliError } from "../../src/cli/core/errors.ts";
import { createStyle } from "../../src/cli/core/style.ts";
import { loadConfig } from "../../src/cli/project/config.ts";
import { dateAt } from "../../src/core/time.ts";

function lined(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

function contextFor(
  cwd: string,
  io: CliIo,
  json: boolean,
): Promise<CliContext> {
  return loadConfig(cwd).then((config) => ({
    command: "rls generate",
    cwd,
    config,
    configWarnings: [],
    io,
    env: io.env ?? process.env,
    now: io.now?.() ?? dateAt(),
    json,
    format: json ? "json" : "text",
    color: false,
    errStyle: createStyle(false),
    interactive: false,
    agent: false,
    yes: true,
    debug: false,
    signal: io.signal ?? new AbortController().signal,
    argv: ["generate", "--only", "rls"],
    addSecret() {
      return undefined;
    },
    log(message: string) {
      io.stderr(message);
    },
    trace() {
      return undefined;
    },
    progress() {
      return {
        done() {
          return undefined;
        },
      };
    },
  }));
}

/**
 * Runs the RLS generator with the flags a test used to pass to `rls generate`.
 * The command itself is gone; the flags are the `rls()` options.
 */
export async function rlsGenerate(
  flags: readonly string[],
  options?: { readonly cwd?: string; readonly io?: CliIo },
): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    ...options?.io,
    stdout(text) {
      stdout.push(text);
      options?.io?.stdout(text);
    },
    stderr(text) {
      stderr.push(text);
      options?.io?.stderr(text);
    },
  };
  const cwd = options?.cwd ?? process.cwd();
  const finish = (code: RunResult["code"], output: string): RunResult => {
    if (output !== "") {
      const chunk = lined(output);
      if (code === 0 || code === 1) {
        stdout.push(chunk);
      } else {
        stderr.push(chunk);
      }
    }
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  };
  try {
    const ctx = await contextFor(cwd, io, false);
    const result = await rlsGenerateFromFlags(ctx, flags);
    return finish(result.code, result.output);
  } catch (error) {
    const message = error instanceof CliError ? error.message : String(error);
    return finish(2, message);
  }
}
