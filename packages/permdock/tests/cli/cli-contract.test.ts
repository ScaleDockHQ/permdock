import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { commands, isCommand } from "../../src/cli/commands/index.ts";
import { CliError, usageResult } from "../../src/cli/errors.ts";
import { packageRoot } from "../../src/cli/package-root.ts";
import { run } from "../../src/cli/run.ts";
import { project, removeProjects } from "./doctor-kit.ts";

const NAMES = Object.keys(commands).filter(isCommand);
const FIXTURE = join(import.meta.dirname, "fixtures/mini-app");

describe("permdock --version", () => {
  const version: unknown = JSON.parse(
    readFileSync(join(packageRoot(), "package.json"), "utf8"),
  ).version;

  it.each([["--version"], ["-v"]])(
    "prints the package version for %s",
    async (flag) => {
      expect(await run([flag])).toEqual({
        code: 0,
        stdout: `${String(version)}\n`,
        stderr: "",
      });
    },
  );
});

describe("help", () => {
  it("matches the recorded root help", async () => {
    const { code, stdout } = await run(["--help", "--no-color"]);
    expect(code).toBe(0);
    await expect(stdout).toMatchFileSnapshot("__snapshots__/help/root.txt");
  });

  it.each(NAMES)("matches the recorded %s help", async (name) => {
    const { code, stdout } = await run([name, "--help", "--no-color"]);
    expect(code).toBe(0);
    await expect(stdout).toMatchFileSnapshot(`__snapshots__/help/${name}.txt`);
  });
});

describe("Problem Details under --json", () => {
  it("prints a usage problem on stdout for an unknown command", async () => {
    const result = await run(["nope", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      type: "https://permdock.com/problems/cli-usage",
      title: "Usage or configuration error",
      detail: expect.stringContaining("unknown command 'nope'"),
      exitCode: 2,
    });
  });

  it("names the command and exits 1 when the database does not answer", async () => {
    const result = await run([
      "rls",
      "verify",
      "--introspect",
      "--db",
      "postgres://permdock:permdock@127.0.0.1:1/missing",
      "--json",
      "--cwd",
      FIXTURE,
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      type: "https://permdock.com/problems/cli-unavailable",
      title: "A database or service the command needs did not answer",
      detail: "PermDock CLI: rls verify --introspect could not connect",
      command: "rls",
      exitCode: 1,
    });
  });

  it("keeps a message on stderr without --json", async () => {
    const result = await run(["nope"]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown command 'nope'");
  });
});

describe("usageResult", () => {
  it("reports a usage error and lets a CliError through to run()", () => {
    expect(usageResult(new Error("bad flag"))).toEqual({
      code: 2,
      output: "bad flag",
    });
    expect(usageResult("plain")).toEqual({ code: 2, output: "plain" });
    const down = new CliError("unavailable", "down");
    expect(() => usageResult(down)).toThrow(down);
  });
});

describe("--yes", () => {
  it("never prompts at a terminal", async () => {
    const cwd = project({});
    try {
      const result = await run(["skills", "list", "--yes"], {
        cwd,
        io: {
          stdout: () => undefined,
          stderr: () => undefined,
          interactive: true,
        },
      });
      expect(result.code).toBe(0);
    } finally {
      removeProjects();
    }
  });
});
