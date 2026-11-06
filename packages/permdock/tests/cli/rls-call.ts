import type { CliContext } from "../../src/cli/core/context.ts";
import type { CommandResult } from "../../src/cli/core/result.ts";
import type { CliIo, RunResult } from "../../src/cli/types.ts";

import { genFromFlags } from "../../src/cli/commands/gen.ts";
import { openapiEmitFromFlags } from "../../src/cli/commands/openapi.ts";
import { powersyncGenerateFromFlags } from "../../src/cli/commands/powersync.ts";
import { rlsGenerateFromFlags } from "../../src/cli/commands/rls.ts";
import { scimGenerateFromFlags } from "../../src/cli/commands/scim.ts";
import { hookGenerateFromFlags } from "../../src/cli/commands/supabase.ts";
import { CliError, problemOf } from "../../src/cli/core/errors.ts";
import { envelope } from "../../src/cli/core/output.ts";
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

function withoutGlobals(flags: readonly string[]): {
  readonly flags: readonly string[];
  readonly json: boolean;
  readonly cwd: string | undefined;
} {
  const kept: string[] = [];
  let json = false;
  let cwd: string | undefined;
  for (let index = 0; index < flags.length; index += 1) {
    const token = flags[index] ?? "";
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--no-color" || token === "--color") {
      continue;
    }
    if (token === "--cwd" || token === "--config" || token === "--agent") {
      if (token === "--cwd") cwd = flags[index + 1];
      index += 1;
      continue;
    }
    kept.push(token);
  }
  return { flags: kept, json, cwd };
}

async function runRemoved(
  flags: readonly string[],
  run: (ctx: CliContext, argv: readonly string[]) => Promise<CommandResult>,
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
  const parsed = withoutGlobals(flags);
  const cwd = options?.cwd ?? parsed.cwd ?? process.cwd();
  const finish = (
    code: RunResult["code"],
    output: string,
    data?: unknown,
    error?: unknown,
  ): RunResult => {
    if (parsed.json) {
      const body =
        code === 0
          ? envelope({
              status: "success",
              ...(data === undefined ? {} : { data }),
            })
          : envelope({
              status: code === 3 ? "action_required" : "error",
              error: problemOf(error ?? new Error(output), undefined),
            });
      stdout.push(`${JSON.stringify(body, null, 2)}\n`);
      return { code, stdout: stdout.join(""), stderr: stderr.join("") };
    }
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
    const ctx = await contextFor(cwd, io, parsed.json);
    const result = await run(ctx, parsed.flags);
    return finish(result.code, result.output, result.data);
  } catch (error) {
    const message = error instanceof CliError ? error.message : String(error);
    return finish(2, message, undefined, error);
  }
}

/** The hook SQL, with the flags a test used to pass to `supabase hook generate`. */
export function hookGenerate(
  flags: readonly string[],
  options?: { readonly cwd?: string; readonly io?: CliIo },
): Promise<RunResult> {
  return runRemoved(flags, hookGenerateFromFlags, options);
}

/** Sync Streams, with the flags a test used to pass to `powersync generate`. */
export function powersyncGenerate(
  flags: readonly string[],
  options?: { readonly cwd?: string; readonly io?: CliIo },
): Promise<RunResult> {
  return runRemoved(flags, powersyncGenerateFromFlags, options);
}

/** The SCIM tables, with the flags a test used to pass to `scim generate`. */
export function scimGenerate(
  flags: readonly string[],
  options?: { readonly cwd?: string; readonly io?: CliIo },
): Promise<RunResult> {
  return runRemoved(flags, scimGenerateFromFlags, options);
}

/**
 * An annotated OpenAPI document, with the flags a test used to pass to `openapi
 * emit`.
 */
export function openapiEmit(
  flags: readonly string[],
  options?: { readonly cwd?: string; readonly io?: CliIo },
): Promise<RunResult> {
  return runRemoved(flags, openapiEmitFromFlags, options);
}

/** Typed modules, with the flags a test used to pass to `gen`. */
export function typedGen(
  flags: readonly string[],
  options?: { readonly cwd?: string; readonly io?: CliIo },
): Promise<RunResult> {
  return runRemoved(flags, genFromFlags, options);
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
