import type { ArgsDef, Resolvable, SubCommandsDef } from "citty";

import type { CliIo, PermDockConfig } from "../types.ts";

/** A command definition as a parent's `subCommands` holds it, whatever its args. */
export type Command = Extract<
  SubCommandsDef[string],
  { readonly meta?: unknown }
>;

/** What a command returns: the exit code and the text printed to stdout. */
export type CommandResult = {
  readonly code: 0 | 1 | 2;
  readonly output: string;
};

/** One invocation's resolved globals; a command reports its result through `report`. */
export type CliContext = {
  readonly cwd: string;
  readonly config: PermDockConfig;
  /** The `--config` value as given; unset when the default file was found. */
  readonly configFile?: string;
  readonly io: CliIo;
  readonly now: Date;
  readonly json: boolean;
  readonly color: boolean;
  /** A person at a terminal and not `--json`: a command may prompt. */
  readonly interactive: boolean;
  readonly report: (result: CommandResult) => void;
};

/** Flags every command accepts. `run()` reads them from anywhere in argv. */
export const globalArgs = {
  cwd: {
    type: "string",
    description: "Run as if started in this directory",
    valueHint: "dir",
  },
  config: {
    type: "string",
    description: "Config file (default permdock.config.{ts,mts,js,mjs})",
    valueHint: "file",
  },
  json: { type: "boolean", description: "Machine-readable output" },
  yes: {
    type: "boolean",
    alias: "y",
    description: "Never prompt; take the answer the flags give",
  },
  color: {
    type: "boolean",
    description: "Styled output on a colour terminal",
    default: true,
    negativeDescription: "Plain output",
  },
} as const;

/**
 * A list flag: every `--name a,b` and `--name=c` occurrence, comma-split and
 * trimmed, in order. citty keeps only the last occurrence of a string flag.
 */
export function listArg(rawArgs: readonly string[], name: string): string[] {
  const values: string[] = [];
  const flag = `--${name}`;
  for (const [i, token] of rawArgs.entries()) {
    if (token === "--") {
      break;
    }
    let value: string | undefined;
    if (token.startsWith(`${flag}=`)) {
      value = token.slice(flag.length + 1);
    } else if (token === flag) {
      const next = rawArgs[i + 1];
      if (next !== undefined && (next === "-" || !next.startsWith("-"))) {
        value = next;
      }
    }
    if (value !== undefined) {
      values.push(...value.split(",").map((item) => item.trim()));
    }
  }
  return values;
}

/** A command's flag and positional definitions, whatever form it declared them in. */
export function resolveArgs(command: Command): ArgsDef | Promise<ArgsDef> {
  const args: Resolvable<ArgsDef> | undefined = command.args;
  if (args === undefined) {
    return {};
  }
  return typeof args === "function" ? args() : args;
}

/** A string flag, `undefined` when absent or given without a value. */
export function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
