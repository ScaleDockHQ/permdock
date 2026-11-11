import type { CliContext } from "../../src/cli/core/context.ts";
import type { CommandResult } from "../../src/cli/core/result.ts";
import type { CliIo, PermDockConfig, RunResult } from "../../src/cli/types.ts";

import { genFromFlags } from "../../src/cli/commands/gen.ts";
import { openapiEmitFromFlags } from "../../src/cli/commands/openapi.ts";
import { powersyncGenerateFromFlags } from "../../src/cli/commands/powersync.ts";
import { rlsGenerateFromFlags } from "../../src/cli/commands/rls.ts";
import { scimGenerateFromFlags } from "../../src/cli/commands/scim.ts";
import { hookGenerateFromFlags } from "../../src/cli/commands/supabase.ts";
import {
  CliError,
  cliFailure,
  exitCodeOfError,
  failureOf,
  kindOfCode,
} from "../../src/cli/core/errors.ts";
import {
  dataOf,
  errorDocument,
  resultDocument,
} from "../../src/cli/core/output.ts";
import { createStyle } from "../../src/cli/core/style.ts";
import { loadConfig } from "../../src/cli/project/config.ts";
import { dateAt } from "../../src/core/time.ts";

/**
 * Verbs the fixtures grant that do not infer a SQL command. Generation fails
 * closed without an `rls.actions` entry; the fixtures mean "no policy".
 */
const DECLARED_NONE = [
  "accept",
  "archive",
  "assignRole",
  "close",
  "disable",
  "download",
  "export",
  "manage",
  "pay",
  "publish",
  "revert",
  "review",
  "transfer",
  "view",
  "void",
] as const;

function declareActions(config: PermDockConfig): PermDockConfig {
  const rls = config.rls ?? {};
  return {
    ...config,
    rls: {
      ...rls,
      actions: {
        ...Object.fromEntries(DECLARED_NONE.map((verb) => [verb, "none"])),
        ...rls.actions,
      },
    },
  };
}

function isReport(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    !(Object.keys(data).length === 1 && "message" in data)
  );
}

function problemDetail(output: string, data: unknown): string {
  if (!isReport(data)) {
    return output.trim();
  }
  if (typeof data === "object" && data !== null) {
    const detail = Reflect.get(data, "detail");
    if (typeof detail === "string") {
      return detail;
    }
  }
  return "The command reported a problem; see data";
}

/**
 * What `run` prints for `--json`: the cli-result-v2 result document on stdout
 * for a success or a report, the error document as one line on stderr
 * otherwise.
 */
function jsonDocuments(
  code: RunResult["code"],
  output: string,
  data: unknown,
  error?: unknown,
): { readonly stdout: string; readonly stderr: string } {
  if (error !== undefined) {
    return {
      stdout: "",
      stderr: `${JSON.stringify(errorDocument(failureOf(error)))}\n`,
    };
  }
  const parsed = dataOf(output);
  const body = data ?? parsed;
  const report = data !== undefined || isReport(body) ? body : undefined;
  if (code === 0 || (code === 1 && report !== undefined)) {
    return {
      stdout: `${JSON.stringify(
        resultDocument({
          status: code === 0 ? "success" : "error",
          ...(body === undefined ? {} : { data: body }),
        }),
        null,
        2,
      )}\n`,
      stderr: "",
    };
  }
  return {
    stdout: "",
    stderr: `${JSON.stringify(
      errorDocument(
        cliFailure(kindOfCode(code), problemDetail(output, body), {
          exitCode: code,
        }),
      ),
    )}\n`,
  };
}

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
    config: declareActions(config),
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
    if (
      token === "--no-json" ||
      token === "--no-color" ||
      token === "--color"
    ) {
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
      const printed = jsonDocuments(code, output, data, error);
      stdout.push(printed.stdout);
      stderr.push(printed.stderr);
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
    return finish(exitCodeOfError(error), message, undefined, error);
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
  const parsed = withoutGlobals(flags);
  const cwd = options?.cwd ?? parsed.cwd ?? process.cwd();
  const finish = (
    code: RunResult["code"],
    output: string,
    data?: unknown,
  ): RunResult => {
    if (parsed.json) {
      const printed = jsonDocuments(code, output, data);
      stdout.push(printed.stdout);
      stderr.push(printed.stderr);
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
    const result = await rlsGenerateFromFlags(ctx, parsed.flags);
    return finish(result.code, result.output, result.data);
  } catch (error) {
    const code = exitCodeOfError(error);
    const message = error instanceof CliError ? error.message : String(error);
    if (parsed.json) {
      const printed = jsonDocuments(code, message, undefined, error);
      stdout.push(printed.stdout);
      stderr.push(printed.stderr);
      return { code, stdout: stdout.join(""), stderr: stderr.join("") };
    }
    return finish(code, message);
  }
}
