import type { Env } from "./env.ts";

import { CliError } from "./errors.ts";

export type AgentProbe = {
  readonly stdoutIsTty: boolean;
  readonly exists: (path: string) => boolean;
};

export type DetectedAgent =
  | { readonly isAgent: true; readonly name: string }
  | { readonly isAgent: false };

function set(env: Env, name: string): boolean {
  const value = env[name];
  return value !== undefined && value !== "";
}

/**
 * The AI agent running the CLI, from the variables `@vercel/detect-agent`
 * reads, in its order. `CURSOR_TRACE_ID` is also set in Cursor's own terminal,
 * so it counts only when stdout is not a TTY.
 */
export function detectAgent(env: Env, probe: AgentProbe): DetectedAgent {
  const named = env["AI_AGENT"]?.trim();
  if (named !== undefined && named !== "") {
    return {
      isAgent: true,
      name: named === "github-copilot-cli" ? "github-copilot" : named,
    };
  }
  if (set(env, "CURSOR_TRACE_ID") && !probe.stdoutIsTty) {
    return { isAgent: true, name: "cursor" };
  }
  if (
    set(env, "CURSOR_AGENT") ||
    env["CURSOR_EXTENSION_HOST_ROLE"] === "agent-exec"
  ) {
    return { isAgent: true, name: "cursor-cli" };
  }
  if (set(env, "GEMINI_CLI")) {
    return { isAgent: true, name: "gemini" };
  }
  if (
    set(env, "CODEX_SANDBOX") ||
    set(env, "CODEX_CI") ||
    set(env, "CODEX_THREAD_ID")
  ) {
    return { isAgent: true, name: "codex" };
  }
  if (set(env, "ANTIGRAVITY_AGENT")) {
    return { isAgent: true, name: "antigravity" };
  }
  if (set(env, "AUGMENT_AGENT")) {
    return { isAgent: true, name: "augment-cli" };
  }
  if (set(env, "OPENCODE_CLIENT")) {
    return { isAgent: true, name: "opencode" };
  }
  if (set(env, "CLAUDECODE") || set(env, "CLAUDE_CODE")) {
    return {
      isAgent: true,
      name: set(env, "CLAUDE_CODE_IS_COWORK") ? "cowork" : "claude",
    };
  }
  if (set(env, "REPL_ID")) {
    return { isAgent: true, name: "replit" };
  }
  if (
    set(env, "COPILOT_MODEL") ||
    set(env, "COPILOT_ALLOW_ALL") ||
    set(env, "COPILOT_GITHUB_TOKEN")
  ) {
    return { isAgent: true, name: "github-copilot" };
  }
  if (probe.exists("/opt/.devin")) {
    return { isAgent: true, name: "devin" };
  }
  return { isAgent: false };
}

export type AgentMode = "auto" | "yes" | "no";

const MODES: Readonly<Record<string, AgentMode>> = {
  yes: "yes",
  "1": "yes",
  true: "yes",
  no: "no",
  "0": "no",
  false: "no",
  auto: "auto",
};

function modeOf(
  value: string | undefined,
  source: string,
): AgentMode | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const key = value.trim().toLowerCase();
  const mode = Object.hasOwn(MODES, key) ? MODES[key] : undefined;
  if (mode === undefined) {
    throw new CliError(
      "usage",
      `${source} takes auto, yes or no, got '${value}'`,
      {
        code: "invalid_value",
        extensions: source.startsWith("--") ? { flag: source } : {},
      },
    );
  }
  return mode;
}

/**
 * `--agent`, then `PERMDOCK_AGENT`, then detection. An unknown value is a usage
 * error, so a typo never leaves an agent with prompts it cannot answer.
 */
export function agentMode(
  flag: string | undefined,
  env: Env,
  probe: AgentProbe,
): boolean {
  const mode =
    flag === undefined
      ? (modeOf(env["PERMDOCK_AGENT"], "PERMDOCK_AGENT") ?? "auto")
      : (modeOf(flag, "--agent") ?? "auto");
  switch (mode) {
    case "yes":
      return true;
    case "no":
      return false;
    case "auto":
      return detectAgent(env, probe).isAgent;
    default: {
      const never: never = mode;
      return never;
    }
  }
}
