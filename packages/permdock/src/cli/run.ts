import {
  type ArgsDef,
  defineCommand,
  parseArgs,
  renderUsage,
  runCommand,
} from "citty";
import { stripVTControlCharacters } from "node:util";

import type { CliIo, PermDockConfig, RunResult } from "./types.ts";

import {
  type CliContext,
  type Command,
  type CommandResult,
  globalArgs,
  resolveArgs,
  stringArg,
} from "./commands/context.ts";
import {
  COMMAND_DESCRIPTIONS,
  type CommandName,
  commands,
  isCommand,
} from "./commands/index.ts";
import { loadConfig, resolveCwd } from "./config.ts";
import {
  type CliErrorKind,
  cliErrorKind,
  cliProblem,
  exitCodeOf,
} from "./errors.ts";
import { cliVersion } from "./version.ts";

const NAMES = Object.keys(commands).filter(isCommand);

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
  const writeOut = (text: string): void => {
    const line = lined(text);
    io.stdout(line);
    if (options?.io !== undefined) {
      stdoutChunks.push(line);
    }
  };
  const writeErr = (text: string): void => {
    const line = lined(text);
    io.stderr(line);
    if (options?.io !== undefined) {
      stderrChunks.push(line);
    }
  };
  const done = (code: 0 | 1 | 2): RunResult => ({
    code,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  });

  const flags = beforeSeparator(argv);
  const globals = parseArgs<typeof globalArgs>([...flags], globalArgs);
  const json = globals.json === true;
  const color = io.color === true && globals.color !== false;
  const plain = (text: string): string =>
    color ? text : stripVTControlCharacters(text);
  const askedHelp = flags.includes("--help") || flags.includes("-h");
  const first = globals._[0];
  const name = first === "help" ? globals._[1] : first;

  let result: CommandResult | undefined;
  const configFile = stringArg(globals.config);
  const contextFor = (cwd: string, config: PermDockConfig): CliContext => ({
    cwd,
    config,
    ...(configFile === undefined ? {} : { configFile }),
    io,
    now: io.now?.() ?? new Date(),
    json,
    color,
    interactive: io.interactive === true && !json && globals.yes !== true,
    report: (outcome) => {
      result = outcome;
    },
  });

  /** A failed run: text on stderr, or Problem Details on stdout under `--json`. */
  const fail = (
    kind: CliErrorKind,
    message: string,
    command?: string,
  ): RunResult => {
    if (json) {
      writeOut(JSON.stringify(cliProblem(kind, message, command), null, 2));
    } else {
      writeErr(message);
    }
    return done(exitCodeOf(kind));
  };

  if (name !== undefined && !isCommand(name)) {
    return fail(
      "usage",
      `unknown command '${name}'. Use ${new Intl.ListFormat("en-GB", { type: "disjunction" }).format(NAMES)}.`,
    );
  }
  if (
    name === undefined &&
    (flags.includes("--version") || flags.includes("-v"))
  ) {
    writeOut(cliVersion());
    return done(0);
  }
  if (askedHelp || first === "help" || name === undefined) {
    const root = rootCommand();
    const usage =
      name === undefined
        ? await renderUsage(root)
        : await renderUsage(
            await load(name, contextFor(options?.cwd ?? process.cwd(), {})),
            root,
          );
    if (name === undefined && !askedHelp && first !== "help") {
      writeErr(plain(usage));
      return done(2);
    }
    writeOut(plain(usage));
    return done(0);
  }

  const cwd = resolveCwd(stringArg(globals.cwd), options?.cwd ?? process.cwd());
  let config: PermDockConfig;
  try {
    config = await loadConfig(cwd, configFile);
  } catch (error) {
    return fail(
      cliErrorKind(error),
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    const command = await load(name, contextFor(cwd, config));
    const rawArgs = withoutCommand(argv, name);
    await runCommand(command, {
      rawArgs: normaliseValues(rawArgs, await resolveArgs(command)),
    });
  } catch (error) {
    if (!(error instanceof Error)) {
      return fail("usage", String(error), name);
    }
    if (error.name === "CLIError") {
      return fail(
        "usage",
        `${name}: ${stripVTControlCharacters(error.message)}`,
        name,
      );
    }
    return fail(cliErrorKind(error), error.message, name);
  }
  if (result === undefined) {
    return done(0);
  }
  writeOut(result.output);
  return done(result.code);
}

/** The root help lists commands from a static table, so it loads none of them. */
function rootCommand(): Command {
  return defineCommand({
    meta: {
      name: "permdock",
      description:
        "Collect, export, diff and check the permissions a PermDock policy declares",
    },
    args: {
      ...globalArgs,
      version: {
        type: "boolean",
        alias: "v",
        description: "Print the permdock version",
      },
    },
    subCommands: Object.fromEntries(
      NAMES.map((name) => [
        name,
        defineCommand({
          meta: { name, description: COMMAND_DESCRIPTIONS[name] },
        }),
      ]),
    ),
  });
}

async function load(name: CommandName, ctx: CliContext): Promise<Command> {
  return (await commands[name]())(ctx);
}

function lined(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function beforeSeparator(argv: readonly string[]): readonly string[] {
  const end = argv.indexOf("--");
  return end === -1 ? argv : argv.slice(0, end);
}

/** argv with the command name removed, wherever the global flags put it. */
function withoutCommand(argv: readonly string[], name: string): string[] {
  const index = argv.findIndex(
    (token, i) =>
      token === name && argv[i - 1] !== "--cwd" && argv[i - 1] !== "--config",
  );
  return argv.filter((_, i) => i !== index);
}

/**
 * A value never starts with `-` (bar `-` itself): `--out --check` is a bare
 * `--out` and `--check`, as it was before citty, which would take `--check`
 * as the value. A bare string flag reads as `''`; a bare enum flag keeps its
 * default.
 */
function normaliseValues(rawArgs: readonly string[], def: ArgsDef): string[] {
  const out: string[] = [];
  for (const [i, token] of rawArgs.entries()) {
    if (token === "--") {
      out.push(...rawArgs.slice(i));
      break;
    }
    const arg = token.startsWith("--") ? def[token.slice(2)] : undefined;
    const next = rawArgs[i + 1];
    const bare = next === undefined || (next !== "-" && next.startsWith("-"));
    if (arg?.type === "enum" && bare) {
      continue;
    }
    out.push(arg?.type === "string" && bare ? `${token}=` : token);
  }
  return out;
}
