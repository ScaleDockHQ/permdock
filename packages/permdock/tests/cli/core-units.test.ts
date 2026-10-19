import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { didYouMean, parseFlags } from "../../src/cli/core/args.ts";
import { defineLeaf } from "../../src/cli/core/command.ts";
import { candidates } from "../../src/cli/core/completion.ts";
import { redact } from "../../src/cli/core/credentials.ts";
import { exitCodeOf, kindOfCode } from "../../src/cli/core/errors.ts";
import { dirtyFiles } from "../../src/cli/core/files.ts";
import { leafHelp, leafJson } from "../../src/cli/core/help.ts";
import { progressReporter, readSecret } from "../../src/cli/core/io.ts";
import { resolve } from "../../src/cli/core/manifest.ts";
import {
  dataOf,
  githubAnnotations,
  sarifLog,
} from "../../src/cli/core/output.ts";
import { renameMessage } from "../../src/cli/core/renames.ts";
import { run } from "../../src/cli/core/run.ts";
import { trapSignals } from "../../src/cli/core/signals.ts";
import { createStyle } from "../../src/cli/core/style.ts";
import { byCodeUnit, byKey } from "../../src/cli/shared/compare.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures/mini-app");
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("progressReporter", () => {
  it("prints plain lines off a terminal", () => {
    const lines: string[] = [];
    const report = progressReporter({
      write: (text) => {
        lines.push(text);
      },
      tty: false,
      style: createStyle(false),
    });
    report("Loading").done("Loaded");
    report("Checking").done();
    expect(lines).toEqual(["Loading\n", "Loaded\n", "Checking\n"]);
  });

  it("spins on a terminal and clears the line when done", () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const report = progressReporter({
      write: (text) => {
        lines.push(text);
      },
      tty: true,
      style: createStyle(false),
    });
    const first = report("Loading");
    vi.advanceTimersByTime(200);
    first.done("Loaded");
    report("Checking").done();
    expect(lines.length).toBeGreaterThan(4);
    expect(lines.filter((line) => line.includes("Loading")).length).toBe(3);
    expect(
      lines.some(
        (line) => line.startsWith("\r\u001B[2K") && line.endsWith(" Loaded\n"),
      ),
    ).toBe(true);
    expect(lines.at(-1)).toBe("\r\u001B[2K");
  });
});

describe("readSecret", () => {
  it("reads the first line, trimmed, and nothing as undefined", async () => {
    expect(await readSecret(undefined)).toBeUndefined();
    expect(await readSecret(() => Promise.resolve("  \n"))).toBeUndefined();
    expect(
      await readSecret(() => Promise.resolve(" postgres://x \r\nrest")),
    ).toBe("postgres://x");
  });
});

describe("trapSignals", () => {
  it("aborts on the first signal, exits on the second, and removes its handlers", () => {
    vi.useFakeTimers();
    const handlers = new Map<string, () => void>();
    // SAFETY: trapSignals registers only SIGINT and SIGTERM handlers, which take no arguments
    vi.spyOn(process, "on").mockImplementation(((
      name: string,
      handler: () => void,
    ) => {
      handlers.set(name, handler);
      return process;
    }) as typeof process.on);
    // SAFETY: the stub returns process, as process.off does
    const off = vi
      .spyOn(process, "off")
      .mockImplementation((() => process) as typeof process.off);
    // SAFETY: the stub records the call instead of exiting; trapSignals ignores the return
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);
    const before = process.exitCode;
    const trap = trapSignals();
    try {
      handlers.get("SIGTERM")?.();
      expect(trap.signal.aborted).toBe(true);
      expect(process.exitCode).toBe(143);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2000);
      expect(exit).toHaveBeenCalledWith(143);
      handlers.get("SIGTERM")?.();
      expect(exit).toHaveBeenCalledTimes(2);
    } finally {
      process.exitCode = before;
      trap.dispose();
    }
    expect(off).toHaveBeenCalledTimes(2);
  });
});

describe("exit codes", () => {
  it("map each kind to its code and back", () => {
    expect(exitCodeOf("cancelled")).toBe(130);
    expect(exitCodeOf("action")).toBe(3);
    expect(
      ([0, 1, 2, 3, 130, 143] as const).map((code) => kindOfCode(code)),
    ).toEqual([
      "failed",
      "failed",
      "usage",
      "action",
      "cancelled",
      "cancelled",
    ]);
  });
});

describe("parseFlags", () => {
  const flags = {
    "dry-run": { type: "boolean", description: "Preview" },
  } as const;

  it("reads --flag=true and --no-flag=false, and refuses another value", () => {
    expect(
      parseFlags("x", ["--dry-run=true"], flags).values.get("dry-run"),
    ).toBe(true);
    expect(
      parseFlags("x", ["--no-dry-run=false"], flags).values.get("dry-run"),
    ).toBe(true);
    expect(() => parseFlags("x", ["--dry-run=yes"], flags)).toThrow(
      "x: --dry-run takes true or false, got 'yes'",
    );
  });

  it("suggests nothing without names", () => {
    expect(didYouMean("x", [])).toBeUndefined();
  });
});

describe("resolve", () => {
  it("stops at -- and reads a lone - as an unknown command", () => {
    expect(resolve(["--", "rls"])).toMatchObject({
      kind: "group",
      path: [],
      rest: ["--", "rls"],
    });
    expect(resolve(["rls", "-", "generate"])).toMatchObject({
      kind: "group",
      path: ["rls"],
      unknown: "-",
    });
  });
});

describe("output", () => {
  it("reads empty output as no data", () => {
    expect(dataOf("  \n")).toBeUndefined();
  });

  const findings = [
    {
      code: "PD001",
      severity: "error",
      message: "a, b: c",
      file: "src/a,b.ts",
      line: 3,
      fix: "Do x",
    },
    { code: "PD002", severity: "warning", message: "w", file: "src/w.ts" },
    { code: "PD003", severity: "info", message: "i" },
  ] as const;

  it("maps severities and locations to GitHub annotations", () => {
    expect(githubAnnotations(findings).split("\n")).toEqual([
      "::error file=src/a%2Cb.ts,line=3,title=PD001::a, b: c%0AFix: Do x",
      "::warning file=src/w.ts,title=PD002::w",
      "::notice title=PD003::i",
    ]);
  });

  it("maps severities and locations to SARIF results", () => {
    const log: unknown = JSON.parse(sarifLog("doctor", findings));
    expect(log).toMatchObject({
      runs: [
        {
          results: [
            {
              level: "error",
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "src/a,b.ts" },
                    region: { startLine: 3 },
                  },
                },
              ],
            },
            {
              level: "warning",
              locations: [
                { physicalLocation: { artifactLocation: { uri: "src/w.ts" } } },
              ],
            },
            { level: "note" },
          ],
        },
      ],
    });
  });

  it("puts a finding's fix on its SARIF rule", () => {
    const log: unknown = JSON.parse(
      sarifLog("doctor", [
        { code: "PD001", severity: "info", message: "m", fix: "Do x" },
      ]),
    );
    expect(log).toMatchObject({
      runs: [
        {
          tool: {
            driver: { rules: [{ id: "PD001", help: { text: "Do x" } }] },
          },
          results: [{ level: "note" }],
        },
      ],
    });
  });
});

describe("candidates", () => {
  it("offers the root commands for no words at all", async () => {
    expect(await candidates([])).toContain("rls");
  });

  it("offers nothing for a bare word after a leaf without positionals", async () => {
    expect(await candidates(["doctor", ""])).toEqual([]);
  });
});

describe("leaf help", () => {
  const leaf = defineLeaf({
    flags: {
      name: { type: "string", description: "A name" },
      internal: { type: "boolean", description: "Not shown", hidden: true },
      token: {
        type: "string",
        description: "A token",
        secret: { stdinFlag: "token-stdin" },
      },
    },
    run: () => ({ code: 0, output: "" }),
  });
  const entry = {
    kind: "leaf",
    name: "demo",
    summary: "A demo command",
    examples: [],
    docs: "demo",
    effects: [],
    config: false,
    load: () => Promise.resolve(leaf),
  } as const;

  it("names a value without a hint, hides hidden flags and omits empty examples", () => {
    const text = leafHelp(["demo"], entry, leaf, false);
    expect(text).toContain("--name <value>");
    expect(text).not.toContain("--internal");
    expect(text).not.toContain("Examples");
    expect(text).not.toContain("Arguments");
  });

  it("marks a secret flag without an environment variable", () => {
    expect(leafJson(["demo"], entry, leaf)).toMatchObject({
      flags: expect.arrayContaining([
        expect.objectContaining({
          name: "token",
          secret: true,
          stdinFlag: "token-stdin",
        }),
      ]),
    });
  });
});

describe("renameMessage", () => {
  it("says a flag was removed when it has no replacement", () => {
    expect(renameMessage("scan", { commands: ["scan"], from: "--old" })).toBe(
      "scan: --old was removed in 0.5.0.",
    );
  });
});

describe("byCodeUnit", () => {
  it("orders by code unit, uppercase before lowercase", () => {
    expect(["b", "a", "B", "a"].toSorted(byCodeUnit)).toEqual([
      "B",
      "a",
      "a",
      "b",
    ]);
    expect(byKey(["x", 1], ["x", 2])).toBe(0);
  });
});

describe("redact", () => {
  it("leaves secrets shorter than four characters alone", () => {
    expect(redact("abc postgres://u:pw@h/db", ["ab"])).toBe(
      "abc postgres://u:***@h/db",
    );
  });
});

describe("dirtyFiles", () => {
  it("has nothing to check without paths", () => {
    expect(dirtyFiles(FIXTURE, [])).toEqual([]);
  });

  it("counts nothing as dirty outside a git work tree", () => {
    const dir = mkdtempSync(join("/tmp", "permdock-nogit-"));
    temps.push(dir);
    expect(dirtyFiles(dir, ["a.ts"])).toEqual([]);
  });
});

describe("run", () => {
  const quiet = { stdout: () => undefined, stderr: () => undefined };

  it("refuses an empty secret on stdin", async () => {
    const result = await run(["rls", "verify", "--db-url-stdin", "--json"], {
      cwd: FIXTURE,
      io: { ...quiet, readStdin: () => Promise.resolve("\n") },
    });
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { detail: "rls verify: --db-url-stdin read nothing from stdin" },
    });
  });

  it("names the renamed --format of a leaf and refuses an unknown one", async () => {
    const renamed = await run(
      ["rls", "verify", "--format", "pgtap", "--json"],
      {
        cwd: FIXTURE,
      },
    );
    expect(JSON.parse(renamed.stdout)).toMatchObject({
      error: { code: "flag_renamed" },
    });
    const unknown = await run(["doctor", "--format", "xml", "--json"], {
      cwd: FIXTURE,
    });
    expect(JSON.parse(unknown.stdout)).toMatchObject({
      error: { code: "invalid_value" },
    });
  });

  it("prints a leaf's help as JSON when asked", async () => {
    const result = await run(["rls", "generate", "--help", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ path: "rls generate" });
  });

  it("refuses an unknown init integration and an unknown completion shell", async () => {
    const init = await run(["init", "--integration", "nope", "--json"], {
      cwd: FIXTURE,
    });
    expect(init.code).toBe(2);
    const shell = await run(["completion", "tcsh", "--json"], { cwd: FIXTURE });
    expect(JSON.parse(shell.stdout)).toMatchObject({
      error: { code: "invalid_value" },
    });
  });

  it("writes the skills for the client skills update names", async () => {
    const cwd = mkdtempSync(join("/tmp", "permdock-skills-"));
    temps.push(cwd);
    const result = await run(
      ["skills", "update", "--client", "cursor", "--json"],
      {
        cwd,
      },
    );
    expect(result.code).toBe(0);
    expect(existsSync(join(cwd, ".cursor/skills/permdock/SKILL.md"))).toBe(
      true,
    );
  });

  it("quotes an argument with a quote in the command consent asks for", async () => {
    const result = await run(["codemod", "0.5", "it's", "--agent", "yes"], {
      cwd: FIXTURE,
    });
    expect(result.code).toBe(3);
    expect(result.stdout).toContain(
      String.raw`permdock codemod 0.5 'it'\\''s' --confirm `,
    );
  });

  it("reads an empty DATABASE_URL as unset and checks the fixtures instead", async () => {
    const result = await run(["rls", "verify", "--json"], {
      cwd: FIXTURE,
      io: { ...quiet, env: { DATABASE_URL: "" } },
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { detail: "PermDock CLI: fixtures not found: rls.fixtures.json" },
    });
  });

  it("asks rls import for its input when DATABASE_URL is empty", async () => {
    const result = await run(["rls", "import", "--json"], {
      cwd: FIXTURE,
      io: { ...quiet, env: { DATABASE_URL: "" } },
    });
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "input_required" },
    });
  });

  it("completes nothing for a word no command starts with", async () => {
    const result = await run(["__complete", "--", "zzz"]);
    expect(result).toMatchObject({ code: 0, stdout: "" });
  });

  it("asks rls migrate for --sql", async () => {
    const result = await run(["rls", "migrate", "--json"], { cwd: FIXTURE });
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "input_required" },
    });
  });

  it("names the missing positional and the command that supplies it", async () => {
    const result = await run(["preset", "decode", "--json"], { cwd: FIXTURE });
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "action_required",
      error: { code: "input_required", missing: ["<code>"] },
      next: [{ command: "permdock preset decode --json <code>" }],
    });
  });

  it("refuses an --agent or PERMDOCK_AGENT value outside auto, yes and no", async () => {
    const flag = await run(["config", "--agent=maybe", "--json"], {
      cwd: FIXTURE,
    });
    expect(flag.code).toBe(2);
    expect(JSON.parse(flag.stdout)).toMatchObject({
      error: {
        code: "invalid_value",
        detail: "--agent takes auto, yes or no, got 'maybe'",
      },
    });
    const env = await run(["config", "--json"], {
      cwd: FIXTURE,
      io: { ...quiet, env: { PERMDOCK_AGENT: "maybe" } },
    });
    expect(env.code).toBe(2);
    expect(JSON.parse(env.stdout)).toMatchObject({
      error: { code: "invalid_value" },
    });
  });

  it("logs the stack and the cause of a failure with --debug", async () => {
    const result = await run(["rls", "verify", "--db-url-stdin", "--debug"], {
      cwd: FIXTURE,
      io: { ...quiet, readStdin: () => Promise.resolve("") },
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("CliError");
  });
});
