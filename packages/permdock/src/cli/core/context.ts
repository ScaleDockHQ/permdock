import type { CliIo, PermDockConfig } from "../types.ts";
import type { Flags } from "./command.ts";
import type { Env } from "./env.ts";
import type { Style } from "./style.ts";

export type OutputFormat = "text" | "json" | "github" | "sarif";

/** One invocation's resolved globals, shared by every leaf. */
export type CliContext = {
  /** The leaf's path, such as `rls generate`. */
  readonly command: string;
  readonly cwd: string;
  readonly config: PermDockConfig;
  /** The `--config` value as given; unset when the default file was found. */
  readonly configFile?: string;
  /** The config file read, absolute; unset when there is none. */
  readonly configPath?: string;
  /** Keys in the config file PermDock does not read. */
  readonly configWarnings: readonly string[];
  readonly io: CliIo;
  readonly env: Env;
  readonly now: Date;
  /** `--json` or `--format json`: the leaf builds its JSON report. */
  readonly json: boolean;
  readonly format: OutputFormat;
  /** Styled stdout. */
  readonly color: boolean;
  /** Styling for stderr, which takes colour on its own terms. */
  readonly errStyle: Style;
  /**
   * A person at a terminal, not an agent, not `--json`, not `--yes`: a leaf may
   * prompt.
   */
  readonly interactive: boolean;
  /** An AI agent runs the CLI: no prompts, no login flow. */
  readonly agent: boolean;
  readonly yes: boolean;
  readonly debug: boolean;
  readonly signal: AbortSignal;
  /** The argv the leaf ran with, for `next` steps and consent tokens. */
  readonly argv: readonly string[];
  /** Masks `value` in everything the run prints from now on. */
  readonly addSecret: (value: string) => void;
  /** A line on stderr; never on stdout, which carries data only. */
  readonly log: (message: string) => void;
  /** A line on stderr under `--debug`. */
  readonly trace: (message: string) => void;
  /** A spinner on an interactive stderr, a plain log line otherwise. */
  readonly progress: (message: string) => {
    readonly done: (message?: string) => void;
  };
};

/** Flags every command accepts, read from anywhere before `--`. */
export const GLOBAL_FLAGS: Flags = {
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
  json: {
    type: "boolean",
    description: "Print the cli-result-v1 JSON envelope on stdout",
  },
  format: {
    type: "enum",
    options: ["text", "json", "github", "sarif"],
    description: "Output format; github and sarif render findings",
  },
  yes: {
    type: "boolean",
    alias: "y",
    description: "Never prompt; take the answer the flags give",
  },
  confirm: {
    type: "string",
    description:
      "The token a consent_required result gave, once the person agreed",
    valueHint: "token",
  },
  agent: {
    type: "enum",
    options: ["auto", "yes", "no"],
    description:
      "Agent mode: no prompts, JSON by default (default auto, PERMDOCK_AGENT)",
  },
  debug: {
    type: "boolean",
    description: "Log each step and the cause of an error on stderr",
  },
  color: {
    type: "boolean",
    description: "Styled output on a colour terminal",
    default: true,
    negativeDescription: "Plain output",
  },
  help: { type: "boolean", alias: "h", description: "Print help" },
};
