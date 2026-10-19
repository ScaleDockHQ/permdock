import { existsSync, statSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

import type { CliIo, RunResult } from "../types.ts";
import type { Leaf } from "./command.ts";
import type { CommandResult } from "./result.ts";

import { dateAt } from "../../core/time.ts";
import {
  type LoadedConfig,
  readConfig,
  resolveCwd,
} from "../project/config.ts";
import { agentMode } from "./agent.ts";
import { flagSpellings, parseFlags, parseLeaf, suggestion } from "./args.ts";
import { type CliContext, GLOBAL_FLAGS, type OutputFormat } from "./context.ts";
import { redact } from "./credentials.ts";
import {
  type CliProblem,
  type ExitCode,
  CliError,
  cliProblem,
  describeError,
  kindOfCode,
  problemOf,
} from "./errors.ts";
import {
  commandsJson,
  groupHelp,
  leafHelp,
  leafJson,
  rootHelp,
} from "./help.ts";
import { progressReporter } from "./io.ts";
import { type GroupEntry, type LeafEntry, resolve } from "./manifest.ts";
import { dataOf, envelope, githubAnnotations, sarifLog } from "./output.ts";
import { COMMAND_MOVES, flagRename, renameMessage } from "./renames.ts";
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
    const spelling = token.split("=", 1)[0] ?? token;
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
  return {
    globals: {
      ...(cwd === undefined ? {} : { cwd }),
      ...(config === undefined ? {} : { config }),
      ...(json === undefined ? {} : { json }),
      ...(format === undefined ? {} : { format }),
      ...(agent === undefined ? {} : { agent }),
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

/** The `--flag` tokens before `--`, as typed without a value. */
function typedFlags(argv: readonly string[]): readonly string[] {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end))
    .filter((token) => token.startsWith("--"))
    .map((token) => token.split("=", 1)[0] ?? token);
}

export async function run(
  argv: readonly string[],
  options?: {
    readonly cwd?: string;
    readonly io?: CliIo;
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
  const agent = agentMode(globals.agent, io.env ?? {}, {
    stdoutIsTty: io.stdoutIsTty === true,
    exists: existsSync,
  });
  const color = io.color === true && globals.color;
  const errStyle = createStyle(io.errColor === true && globals.color);
  const plain = (text: string): string =>
    color ? text : stripVTControlCharacters(text);

  const helpWord = rest[0] === "help";
  const resolved = resolve(helpWord ? rest.slice(1) : rest);
  const command = resolved.path.join(" ");
  const askedHelp = globals.help || helpWord;

  const formatOf = (): OutputFormat | CliProblem => {
    const given = globals.format;
    if (given === undefined) {
      return globals.json === true || (agent && globals.json !== false)
        ? "json"
        : "text";
    }
    if (
      given === "text" ||
      given === "json" ||
      given === "github" ||
      given === "sarif"
    ) {
      if (globals.json === true && given !== "json") {
        return cliProblem(
          "usage",
          `--json and --format ${given} ask for different output; pick one`,
          command === "" ? undefined : command,
          { code: "invalid_value" },
        );
      }
      return given;
    }
    if (resolved.kind === "leaf") {
      const rename = flagRename(command, "--format");
      if (rename !== undefined) {
        return cliProblem("usage", renameMessage(command, rename), command, {
          code: "flag_renamed",
          extensions: { flag: "--format", replacement: rename.to },
        });
      }
    }
    return cliProblem(
      "usage",
      `--format '${given}' is not one of text, json, github, sarif.${suggestion(given, ["text", "json", "github", "sarif"])}`,
      command === "" ? undefined : command,
      { code: "invalid_value" },
    );
  };
  const formatOrProblem = formatOf();
  const format: OutputFormat =
    typeof formatOrProblem === "string"
      ? formatOrProblem
      : globals.json === true || (agent && globals.json !== false)
        ? "json"
        : "text";
  const json = format === "json";

  const emitProblem = (
    problem: CliProblem,
    next?: CommandResult["next"],
  ): RunResult => {
    if (json) {
      writeOut(
        JSON.stringify(
          envelope({
            status: problem.exitCode === 3 ? "action_required" : "error",
            error: problem,
            ...(next === undefined ? {} : { next }),
          }),
          null,
          2,
        ),
      );
    } else {
      writeErr(problem.detail);
      for (const step of next ?? []) {
        writeErr(`  ${step.when}: ${step.command}`);
      }
    }
    return done(problem.exitCode);
  };
  const fail = (error: unknown): RunResult => {
    if (globals.debug && error instanceof Error) {
      writeErr(errStyle.paint("dim", error.stack ?? error.message));
      if (error.cause !== undefined) {
        writeErr(errStyle.paint("dim", `cause: ${describeError(error.cause)}`));
      }
    }
    return emitProblem(
      problemOf(error, command === "" ? undefined : command),
      error instanceof CliError ? error.next : undefined,
    );
  };

  if (typeof formatOrProblem !== "string") {
    return emitProblem(formatOrProblem);
  }

  if (resolved.kind === "group") {
    if (resolved.unknown !== undefined) {
      const names = resolved.entry.children
        .filter((child) => child.kind === "group" || child.hidden !== true)
        .map((child) => child.name);
      const where = command === "" ? "permdock" : `permdock ${command}`;
      return fail(
        new CliError(
          "usage",
          `unknown command '${resolved.unknown}' for ${where}.${suggestion(resolved.unknown, names)} Commands: ${names.join(", ")}.`,
          { code: "unknown_command" },
        ),
      );
    }
    if (askedHelp) {
      if (json) {
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
    return bareGroup(resolved.path, resolved.entry, rest);
  }

  if (askedHelp) {
    const leaf = await resolved.entry.load();
    if (json) {
      writeOut(
        JSON.stringify(leafJson(resolved.path, resolved.entry, leaf), null, 2),
      );
      return done(0);
    }
    writeOut(plain(leafHelp(resolved.path, resolved.entry, leaf, color)));
    return done(0);
  }

  return runLeaf(resolved.path, resolved.entry, resolved.rest);

  function bareGroup(
    path: readonly string[],
    group: GroupEntry,
    tokens: readonly string[],
  ): RunResult {
    const name = path.join(" ");
    const moved = COMMAND_MOVES.find((move) => move.from === name);
    if (moved !== undefined && tokens.some((token) => token.startsWith("-"))) {
      return fail(
        new CliError(
          "usage",
          `permdock ${name} needs a command since 0.5.0: permdock ${moved.to}`,
          {
            code: "command_moved",
            extensions: { replacement: `permdock ${moved.to}` },
          },
        ),
      );
    }
    const help =
      path.length === 0 ? rootHelp(false) : groupHelp(path, group, false);
    if (json) {
      return emitProblem(
        cliProblem(
          "usage",
          `permdock${name === "" ? "" : ` ${name}`} needs a command`,
          name === "" ? undefined : name,
          {
            code: "missing_input",
            extensions: {
              choices: group.children
                .filter(
                  (child) => child.kind === "group" || child.hidden !== true,
                )
                .map((child) => `permdock ${[...path, child.name].join(" ")}`),
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
    let leaf: Leaf;
    let input: ReturnType<typeof parseLeaf>;
    try {
      leaf = await entry.load();
    } catch (error) {
      return fail(error);
    }
    const declared = new Set(flagSpellings(leaf.flags));
    for (const flag of typedFlags(tokens)) {
      const rename = declared.has(flag) ? undefined : flagRename(name, flag);
      if (rename !== undefined) {
        return fail(
          new CliError("usage", renameMessage(name, rename), {
            code: "flag_renamed",
            extensions: {
              flag,
              ...(rename.to === undefined ? {} : { replacement: rename.to }),
            },
          }),
        );
      }
    }
    try {
      input = parseLeaf(name, tokens, leaf.flags, leaf.positionals);
    } catch (error) {
      return fail(error);
    }
    let loaded = NO_CONFIG;
    if (entry.config || globals.config !== undefined) {
      try {
        loaded = await readConfig(cwd, globals.config);
      } catch (error) {
        return fail(error);
      }
      if (name !== "config") {
        for (const warning of loaded.warnings) {
          writeErr(errStyle.paint("yellow", `permdock: warning: ${warning}`));
        }
      }
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
      trace: (message) => {
        if (globals.debug) {
          writeErr(errStyle.paint("dim", `debug: ${message}`));
        }
      },
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
    return render(name, result);
  }

  function render(name: string, result: CommandResult): RunResult {
    if (result.streamed === true) {
      return done(result.code);
    }
    if (format === "github" || format === "sarif") {
      const findings = result.findings ?? [];
      writeOut(
        format === "github"
          ? githubAnnotations(findings) || ""
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
            envelope({
              status: "success",
              ...(data === undefined ? {} : { data }),
              ...(result.next === undefined ? {} : { next: result.next }),
            }),
            null,
            2,
          ),
        );
        return done(0);
      }
      const kind = kindOfCode(result.code);
      const report =
        result.data !== undefined || isReport(data) ? data : undefined;
      const problem =
        result.problem ??
        cliProblem(kind, problemDetail(result.output, parsed), name);
      writeOut(
        JSON.stringify(
          envelope({
            status: problem.exitCode === 3 ? "action_required" : "error",
            ...(report === undefined ? {} : { data: report }),
            error: problem,
            ...(result.next === undefined ? {} : { next: result.next }),
          }),
          null,
          2,
        ),
      );
      return done(result.code);
    }
    const text = plain(result.output);
    if (result.problem !== undefined && text.trim() === "") {
      writeErr(result.problem.detail);
    } else if (text !== "") {
      if (result.code === 0 || result.code === 1) {
        writeOut(text);
      } else {
        writeErr(text);
      }
    }
    for (const step of result.next ?? []) {
      writeErr(`  ${step.when}: ${step.command}`);
    }
    return done(result.code);
  }
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
