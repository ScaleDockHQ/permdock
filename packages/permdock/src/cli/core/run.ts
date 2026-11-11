import { existsSync, statSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

import type { LoadedConfig } from "../project/config.ts";
import type { CliIo, RunResult } from "../types.ts";
import type { Leaf } from "./command.ts";
import type { CliContext, OutputFormat } from "./context.ts";
import type { CliFailure, ExitCode } from "./errors.ts";
import type { GroupEntry, LeafEntry } from "./manifest.ts";
import type { CommandResult, NextStep } from "./result.ts";

import { dateAt } from "../../core/time.ts";
import { withPluginOutputs } from "../generate/plugin.ts";
import { readConfig, resolveCwd } from "../project/config.ts";
import { beforeFirst } from "../shared/text.ts";
import { agentMode } from "./agent.ts";
import { parseFlags, parseLeaf, suggestion } from "./args.ts";
import {
  confirmationRequired,
  consentDigest,
  consentReasons,
  quote,
  replayArgv,
} from "./consent.ts";
import { GLOBAL_FLAGS } from "./context.ts";
import { redact } from "./credentials.ts";
import {
  CliError,
  cliFailure,
  describeError,
  failureOf,
  kindOfCode,
} from "./errors.ts";
import {
  commandsJson,
  groupHelp,
  leafHelp,
  leafDocument,
  rootHelp,
} from "./help.ts";
import { progressReporter } from "./io.ts";
import { resolve } from "./manifest.ts";
import {
  dataOf,
  errorDocument,
  githubAnnotations,
  resultDocument,
  sarifLog,
} from "./output.ts";
import { runPluginCommand } from "./plugin-commands.ts";
import { createStyle } from "./style.ts";
import { cliVersion } from "./version.ts";

const NO_CONFIG: LoadedConfig = { config: {}, warnings: [], file: undefined };

type Globals = {
  readonly cwd?: string;
  readonly config?: string;
  readonly json?: boolean;
  readonly format?: string;
  readonly yes: boolean;
  readonly agent?: string;
  readonly effectsDigest?: string;
  readonly debug: boolean;
  readonly color: boolean;
  readonly help: boolean;
};

/** Takes the global flags out of argv, wherever they sit before `--`. */
function extractGlobals(argv: readonly string[]): {
  readonly globals: Globals;
  readonly rest: readonly string[];
} {
  const end = argv.indexOf("--");
  const before = end === -1 ? argv : argv.slice(0, end);
  const after = end === -1 ? [] : argv.slice(end);
  const spellings = new Map<string, string>();
  for (const [name, flag] of Object.entries(GLOBAL_FLAGS)) {
    spellings.set(`--${name}`, name);
    if (flag.type === "boolean") {
      spellings.set(`--no-${name}`, name);
    }
    if ("alias" in flag) {
      spellings.set(`-${flag.alias}`, name);
    }
  }
  const taken: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < before.length; i += 1) {
    const token = before[i] ?? "";
    const spelling = beforeFirst(token, "=");
    const name = token.startsWith("-") ? spellings.get(spelling) : undefined;
    if (name === undefined) {
      rest.push(token);
      continue;
    }
    taken.push(token);
    const flag = GLOBAL_FLAGS[name];
    const next = before[i + 1];
    if (
      flag !== undefined &&
      flag.type !== "boolean" &&
      !token.includes("=") &&
      next !== undefined &&
      (next === "-" || !next.startsWith("-"))
    ) {
      taken.push(next);
      i += 1;
    }
  }
  const lenient = {
    ...GLOBAL_FLAGS,
    format: { type: "string", description: "" },
    agent: { type: "string", description: "" },
  } as const;
  const parsed = parseFlags("permdock", taken, lenient).values;
  const text = (key: string): string | undefined => {
    const value = parsed.get(key);
    return typeof value === "string" ? value : undefined;
  };
  const flag = (key: string): boolean | undefined => {
    const value = parsed.get(key);
    return typeof value === "boolean" ? value : undefined;
  };
  const cwd = text("cwd");
  const config = text("config");
  const json = flag("json");
  const format = text("format");
  const agent = text("agent");
  const effectsDigest = text("effects-digest");
  return {
    globals: {
      ...(cwd === undefined ? {} : { cwd }),
      ...(config === undefined ? {} : { config }),
      ...(json === undefined ? {} : { json }),
      ...(format === undefined ? {} : { format }),
      ...(agent === undefined ? {} : { agent }),
      ...(effectsDigest === undefined ? {} : { effectsDigest }),
      yes: flag("yes") === true,
      debug: flag("debug") === true,
      color: flag("color") !== false,
      help: flag("help") === true,
    },
    rest: [...rest, ...after],
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function lined(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * The step that answers an `input_required` error without its own `next`: the
 * same command line with `--yes` and each missing flag or positional filled by
 * its first choice, or a placeholder the caller replaces.
 */
function missingInputNext(
  argv: readonly string[],
  error: CliError,
): readonly NextStep[] | undefined {
  const missing = error.extensions["missing"];
  if (
    error.code !== "input_required" ||
    !Array.isArray(missing) ||
    !missing.every((item): item is string => typeof item === "string")
  ) {
    return undefined;
  }
  const choices = choicesOf(error.extensions["choices"]);
  const filled = missing.flatMap((item) => {
    const value = choices[item]?.[0];
    if (item.startsWith("--")) {
      return [item, value ?? `<${item.slice(2)}>`];
    }
    return [value ?? item];
  });
  const yes = argv.includes("--yes") || argv.includes("-y") ? [] : ["--yes"];
  const [only] = missing;
  return [
    {
      when:
        missing.length === 1 &&
        only !== undefined &&
        (choices[only]?.length ?? 0) > 1
          ? `with the value the user picks from choices["${only}"]`
          : "with the values the user gives",
      command: ["permdock", ...argv.map(quote), ...filled, ...yes].join(" "),
    },
  ];
}

function choicesOf(
  value: unknown,
): Readonly<Record<string, readonly string[]>> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const out: Record<string, readonly string[]> = {};
  for (const [key, list] of Object.entries(value)) {
    if (
      Array.isArray(list) &&
      list.every((item): item is string => typeof item === "string")
    ) {
      out[key] = list;
    }
  }
  return out;
}

export async function run(
  argv: readonly string[],
  options?: {
    readonly cwd?: string;
    readonly io?: CliIo;
    /** Replaces `plugins` from the config file for this run. */
    readonly plugins?: readonly unknown[];
  },
): Promise<RunResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const io: CliIo = options?.io ?? {
    stdout: (text) => {
      stdoutChunks.push(text);
    },
    stderr: (text) => {
      stderrChunks.push(text);
    },
  };
  const secrets = new Set<string>();
  const writeOut = (text: string): void => {
    const line = redact(lined(text), secrets);
    io.stdout(line);
    if (options?.io !== undefined) {
      stdoutChunks.push(line);
    }
  };
  const writeErrRaw = (raw: string): void => {
    const text = redact(raw, secrets);
    io.stderr(text);
    if (options?.io !== undefined) {
      stderrChunks.push(text);
    }
  };
  const writeErr = (text: string): void => {
    writeErrRaw(lined(text));
  };
  const done = (code: ExitCode): RunResult => ({
    code,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  });

  const first = argv[0];
  if (argv.length === 1 && (first === "--version" || first === "-v")) {
    writeOut(cliVersion());
    return done(0);
  }

  const env = io.env ?? process.env;
  const { globals, rest } = extractGlobals(argv);
  // Detection reads only an env the caller passed, so a programmatic run() is not switched to JSON by its host.
  let agentProblem: CliError | undefined;
  let agent = false;
  try {
    agent = agentMode(globals.agent, io.env ?? {}, {
      stdoutIsTty: io.stdoutIsTty === true,
      exists: existsSync,
    });
  } catch (error) {
    if (!(error instanceof CliError)) {
      throw error;
    }
    agentProblem = error;
  }
  const color = io.color === true && globals.color;
  const errStyle = createStyle(io.errColor === true && globals.color);
  const plain = (text: string): string =>
    color ? text : stripVTControlCharacters(text);
  const trace = (message: string): void => {
    if (globals.debug) {
      writeErr(errStyle.paint("dim", `debug: ${message}`));
    }
  };

  const helpWord = rest[0] === "help";
  const resolved = resolve(helpWord ? rest.slice(1) : rest);
  const command = resolved.path.join(" ");
  const askedHelp = globals.help || helpWord;
  const agentJson =
    agent &&
    globals.json !== false &&
    !(resolved.kind === "leaf" && resolved.entry.shellOutput === true);

  const formatOf = (): OutputFormat | CliFailure => {
    const given = globals.format;
    if (given === undefined) {
      return globals.json === true || agentJson ? "json" : "text";
    }
    if (
      given === "text" ||
      given === "json" ||
      given === "github" ||
      given === "sarif"
    ) {
      if (globals.json === true && given !== "json") {
        return cliFailure(
          "usage",
          `--json and --format ${given} ask for different output; pick one`,
          { code: "invalid_value", extensions: { flag: "--format" } },
        );
      }
      return given;
    }
    return cliFailure(
      "usage",
      `--format '${given}' is not one of text, json, github, sarif.${suggestion(given, ["text", "json", "github", "sarif"])}`,
      { code: "invalid_value", extensions: { flag: "--format" } },
    );
  };
  const formatOrProblem = formatOf();
  const format: OutputFormat =
    typeof formatOrProblem === "string"
      ? formatOrProblem
      : globals.json === true || agentJson
        ? "json"
        : "text";
  const json = format === "json";
  const helpJson = globals.json === true || globals.format === "json";

  const emitFailure = (
    failure: CliFailure,
    next?: readonly NextStep[],
  ): RunResult => {
    if (json) {
      writeErr(JSON.stringify(errorDocument(failure, next)));
    } else {
      writeErr(failure.message);
      for (const step of next ?? []) {
        writeErr(`  ${step.when}: ${step.command}`);
      }
    }
    return done(failure.exitCode);
  };
  const fail = (error: unknown): RunResult => {
    if (globals.debug && error instanceof Error) {
      writeErr(errStyle.paint("dim", error.stack ?? error.message));
      if (error.cause !== undefined) {
        writeErr(errStyle.paint("dim", `cause: ${describeError(error.cause)}`));
      }
    }
    return emitFailure(
      failureOf(error),
      error instanceof CliError
        ? (error.next ?? (json ? missingInputNext(argv, error) : undefined))
        : undefined,
    );
  };

  if (typeof formatOrProblem !== "string") {
    return emitFailure(formatOrProblem);
  }
  if (agentProblem !== undefined) {
    return fail(agentProblem);
  }

  if (resolved.kind === "group") {
    if (resolved.unknown !== undefined) {
      const custom =
        resolved.path.length === 0
          ? await runPluginCommand({
              name: resolved.unknown,
              args: rest.slice(1),
              cwd: resolveCwd(globals.cwd, options?.cwd ?? process.cwd()),
              ...(globals.config === undefined
                ? {}
                : { config: globals.config }),
              ...(options?.plugins === undefined
                ? {}
                : { plugins: options.plugins }),
            })
          : undefined;
      if (custom !== undefined) {
        writeOut(custom.output);
        return done(custom.code);
      }
      const names = resolved.entry.children
        .filter((child) => child.kind === "group" || child.hidden !== true)
        .map((child) => child.name);
      const where = command === "" ? "permdock" : `permdock ${command}`;
      const replacement = replacedGenerate(
        [...resolved.path, resolved.unknown].join(" "),
      );
      const hint =
        replacement === undefined
          ? `${suggestion(resolved.unknown, names)} Commands: ${names.join(", ")}.`
          : ` Did you mean permdock ${replacement}?`;
      return fail(
        new CliError(
          "usage",
          `unknown command '${resolved.unknown}' for ${where}.${hint}`,
          { code: "unknown_command" },
        ),
      );
    }
    if (askedHelp) {
      if (helpJson) {
        writeOut(
          JSON.stringify(
            await commandsJson(resolved.path, resolved.entry),
            null,
            2,
          ),
        );
        return done(0);
      }
      writeOut(
        plain(
          resolved.path.length === 0
            ? rootHelp(color)
            : groupHelp(resolved.path, resolved.entry, color),
        ),
      );
      return done(0);
    }
    return bareGroup(resolved.path, resolved.entry);
  }

  if (askedHelp) {
    const leaf = await resolved.entry.load();
    if (helpJson) {
      writeOut(
        JSON.stringify(
          leafDocument(resolved.path, resolved.entry, leaf),
          null,
          2,
        ),
      );
      return done(0);
    }
    writeOut(plain(leafHelp(resolved.path, resolved.entry, leaf, color)));
    return done(0);
  }

  return runLeaf(resolved.path, resolved.entry, resolved.rest);

  function bareGroup(path: readonly string[], group: GroupEntry): RunResult {
    const name = path.join(" ");
    const help =
      path.length === 0 ? rootHelp(false) : groupHelp(path, group, false);
    if (json) {
      return emitFailure(
        cliFailure(
          "usage",
          `permdock${name === "" ? "" : ` ${name}`} needs a command`,
          {
            code: "usage",
            extensions: {
              choices: {
                "<command>": group.children
                  .filter(
                    (child) => child.kind === "group" || child.hidden !== true,
                  )
                  .map((child) => child.name),
              },
            },
          },
        ),
      );
    }
    writeErr(help);
    return done(2);
  }

  async function runLeaf(
    path: readonly string[],
    entry: LeafEntry,
    tokens: readonly string[],
  ): Promise<RunResult> {
    const name = path.join(" ");
    if (
      (format === "github" || format === "sarif") &&
      entry.findings !== true
    ) {
      return fail(
        new CliError(
          "usage",
          `--format ${format} renders findings, and permdock ${name} reports none; use text or json`,
          { code: "invalid_value" },
        ),
      );
    }
    if (globals.cwd === "") {
      return fail(
        new CliError("usage", "--cwd needs a directory", {
          code: "invalid_value",
        }),
      );
    }
    const cwd = resolveCwd(globals.cwd, options?.cwd ?? process.cwd());
    if (!isDirectory(cwd)) {
      return fail(
        new CliError("usage", `--cwd ${cwd} is not a directory`, {
          code: "invalid_value",
        }),
      );
    }
    if (removedConfirm(tokens)) {
      return fail(
        new CliError(
          "usage",
          "--confirm was removed. Use --yes --effects-digest <digest> instead.",
          {
            code: "flag_renamed",
            extensions: {
              flag: "--confirm",
              suggestion: "--yes --effects-digest <digest>",
            },
          },
        ),
      );
    }
    let leaf: Leaf;
    let input: ReturnType<typeof parseLeaf>;
    try {
      leaf = await entry.load();
    } catch (error) {
      return fail(error);
    }
    try {
      input = parseLeaf(name, tokens, leaf.flags, leaf.positionals);
    } catch (error) {
      return fail(error);
    }
    if (agent) {
      const reasons = consentReasons(entry.effects, input.flags);
      if (reasons.length > 0) {
        const replay = [
          ...replayArgv([...path, ...tokens]),
          ...(globals.cwd === undefined ? [] : ["--cwd", globals.cwd]),
          ...(globals.config === undefined ? [] : ["--config", globals.config]),
        ];
        const digest = consentDigest(reasons, replay, cwd);
        if (!globals.yes || globals.effectsDigest !== digest) {
          return fail(
            confirmationRequired(
              name,
              reasons,
              replay,
              digest,
              globals.effectsDigest !== undefined &&
                globals.effectsDigest !== digest,
            ),
          );
        }
      }
    }
    trace(
      `${name}: agent mode ${agent ? "on" : "off"}, ${format} output, cwd ${cwd}`,
    );
    let loaded = NO_CONFIG;
    const warnings: string[] = [];
    if (entry.config || globals.config !== undefined) {
      try {
        loaded = await readConfig(cwd, globals.config);
      } catch (error) {
        return fail(error);
      }
      trace(
        loaded.file === undefined
          ? "config file: none found"
          : `config file: ${loaded.file}`,
      );
      if (name !== "config") {
        warnings.push(...loaded.warnings);
        for (const warning of loaded.warnings) {
          writeErr(errStyle.paint("yellow", `permdock: warning: ${warning}`));
        }
      }
    }
    if (options?.plugins !== undefined) {
      loaded = {
        ...loaded,
        config: withPluginOutputs({
          ...loaded.config,
          plugins: options.plugins,
        }),
      };
    }
    const signal = io.signal ?? new AbortController().signal;
    const interactive =
      io.interactive === true &&
      !json &&
      !globals.yes &&
      !agent &&
      format === "text";
    const ctx: CliContext = {
      command: name,
      cwd,
      config: loaded.config,
      ...(globals.config === undefined ? {} : { configFile: globals.config }),
      ...(loaded.file === undefined ? {} : { configPath: loaded.file }),
      configWarnings: loaded.warnings,
      io: { ...io, stdout: writeOut, stderr: writeErr },
      env,
      now: io.now?.() ?? dateAt(),
      json,
      format,
      color,
      errStyle,
      interactive,
      agent,
      yes: globals.yes,
      debug: globals.debug,
      signal,
      argv: [...path, ...tokens],
      addSecret: (value) => {
        secrets.add(value);
      },
      log: writeErr,
      trace,
      progress: progressReporter({
        write: writeErrRaw,
        tty: io.stderrIsTty === true && !agent,
        style: errStyle,
      }),
    };
    let result: CommandResult;
    try {
      result = await leaf.run(ctx, input);
    } catch (error) {
      return fail(error);
    }
    trace(`${name}: exit ${String(result.code)}`);
    return render(name, result, warnings);
  }

  function render(
    name: string,
    result: CommandResult,
    warnings: readonly string[],
  ): RunResult {
    if (result.streamed === true) {
      return done(result.code);
    }
    if (format === "github" || format === "sarif") {
      const findings = result.findings ?? [];
      writeOut(
        format === "github"
          ? githubAnnotations(findings)
          : sarifLog(name, findings),
      );
      return done(result.code);
    }
    if (json) {
      const parsed = dataOf(result.output);
      const data = result.data ?? parsed;
      if (result.code === 0) {
        writeOut(
          JSON.stringify(
            resultDocument({
              status: "success",
              ...(data === undefined ? {} : { data }),
              warnings,
              ...(result.next === undefined ? {} : { next: result.next }),
            }),
            null,
            2,
          ),
        );
        return done(0);
      }
      const report =
        result.data !== undefined || isReport(data) ? data : undefined;
      if (
        result.code === 1 &&
        report !== undefined &&
        (result.reason === undefined || result.reason === "check_failed")
      ) {
        if (result.data !== undefined && !isReport(parsed)) {
          writeErr(plain(result.output));
        }
        writeOut(
          JSON.stringify(
            resultDocument({
              status: "error",
              data: report,
              warnings,
              ...(result.next === undefined ? {} : { next: result.next }),
            }),
            null,
            2,
          ),
        );
        return done(1);
      }
      return emitFailure(
        cliFailure(
          kindOfCode(result.code),
          problemDetail(result.output, parsed),
          {
            ...(result.reason === undefined ? {} : { code: result.reason }),
            extensions: detailsOf(report),
            exitCode: result.code,
          },
        ),
        result.next,
      );
    }
    const text = plain(result.output);
    if (text !== "") {
      if (result.code === 0 || result.code === 1) {
        writeOut(text);
      } else {
        writeErr(text);
      }
    }
    return done(result.code);
  }
}

/** The one replacement for a generate command 0.26 removed. */
function replacedGenerate(command: string): string | undefined {
  switch (command) {
    case "rls generate":
      return "generate --only rls";
    case "powersync generate":
      return "generate --only powersync";
    case "openapi emit":
      return "generate --only openapi";
    case "gen":
      return "generate";
    case "scim":
    case "scim generate":
      return "generate --only scim";
    case "supabase hook":
    case "supabase hook generate":
      return "generate --only supabaseHook";
    default:
      return undefined;
  }
}

/** `--confirm` before `--`: removed in favour of `--yes --effects-digest`. */
function removedConfirm(tokens: readonly string[]): boolean {
  const end = tokens.indexOf("--");
  return (end === -1 ? tokens : tokens.slice(0, end)).some(
    (token) => token === "--confirm" || token.startsWith("--confirm="),
  );
}

/** A report as the error document's `data`: an object as is, else `{ result }`. */
function detailsOf(report: unknown): Readonly<Record<string, unknown>> {
  if (report === undefined) {
    return {};
  }
  return typeof report === "object" && report !== null && !Array.isArray(report)
    ? Object.fromEntries(Object.entries(report))
    : { result: report };
}

/** A JSON report object, as opposed to text wrapped as `{ message }`. */
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
