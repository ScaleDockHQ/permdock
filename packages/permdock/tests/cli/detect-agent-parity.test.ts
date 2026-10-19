import { determineAgent } from "@vercel/detect-agent";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { detectAgent } from "../../src/cli/core/agent.ts";

/** Every variable `@vercel/detect-agent` 1.2.5 reads. */
const SIGNALS = [
  "AI_AGENT",
  "CURSOR_TRACE_ID",
  "CURSOR_AGENT",
  "CURSOR_EXTENSION_HOST_ROLE",
  "GEMINI_CLI",
  "CODEX_SANDBOX",
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "ANTIGRAVITY_AGENT",
  "AUGMENT_AGENT",
  "OPENCODE_CLIENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_IS_COWORK",
  "REPL_ID",
  "COPILOT_MODEL",
  "COPILOT_ALLOW_ALL",
  "COPILOT_GITHUB_TOKEN",
] as const;

const CASES: readonly Readonly<Record<string, string>>[] = [
  {},
  { AI_AGENT: "my-agent" },
  { AI_AGENT: "  " },
  { AI_AGENT: "github-copilot-cli" },
  { AI_AGENT: "v0" },
  { CURSOR_TRACE_ID: "t" },
  { CURSOR_AGENT: "1" },
  { CURSOR_EXTENSION_HOST_ROLE: "agent-exec" },
  { CURSOR_EXTENSION_HOST_ROLE: "user" },
  { GEMINI_CLI: "1" },
  { CODEX_SANDBOX: "seatbelt" },
  { CODEX_CI: "1" },
  { CODEX_THREAD_ID: "t" },
  { ANTIGRAVITY_AGENT: "1" },
  { AUGMENT_AGENT: "1" },
  { OPENCODE_CLIENT: "cli" },
  { CLAUDECODE: "1" },
  { CLAUDE_CODE: "1", CLAUDE_CODE_IS_COWORK: "1" },
  { REPL_ID: "r" },
  { COPILOT_MODEL: "gpt" },
  { COPILOT_ALLOW_ALL: "1" },
  { COPILOT_GITHUB_TOKEN: "t" },
  { CLAUDECODE: "1", CURSOR_AGENT: "1", AI_AGENT: "first" },
  { GEMINI_CLI: "1", CODEX_CI: "1" },
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("detectAgent", () => {
  it.each(CASES)(
    "matches @vercel/detect-agent for %j off a TTY",
    async (env) => {
      for (const name of SIGNALS) {
        vi.stubEnv(name, env[name] ?? "");
      }
      const expected = await determineAgent();
      const actual = detectAgent(env, {
        stdoutIsTty: false,
        exists: existsSync,
      });
      expect(actual).toEqual(
        expected.isAgent
          ? { isAgent: true, name: expected.agent.name }
          : { isAgent: false },
      );
    },
  );

  it("ignores CURSOR_TRACE_ID on a TTY, which Cursor sets in a person's terminal too", () => {
    expect(
      detectAgent(
        { CURSOR_TRACE_ID: "t" },
        { stdoutIsTty: true, exists: () => false },
      ),
    ).toEqual({ isAgent: false });
  });

  it("detects Devin from its marker file", () => {
    expect(
      detectAgent(
        {},
        { stdoutIsTty: false, exists: (path) => path === "/opt/.devin" },
      ),
    ).toEqual({ isAgent: true, name: "devin" });
  });
});
