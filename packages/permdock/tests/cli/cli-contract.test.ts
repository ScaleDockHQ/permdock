import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CliError, usageResult } from "../../src/cli/core/errors.ts";
import { leaves } from "../../src/cli/core/manifest.ts";
import { run } from "../../src/cli/core/run.ts";
import { packageRoot } from "../../src/cli/project/package-root.ts";
import { PERMISSIONS, project, removeProjects } from "./doctor-kit.ts";

const PATHS = leaves()
  .filter(({ entry }) => entry.hidden !== true)
  .map(({ path }) => path);
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

  it.each(PATHS)("matches the recorded help for %s", async (...path) => {
    const { code, stdout } = await run([...path, "--help", "--no-color"]);
    expect(code).toBe(0);
    await expect(stdout).toMatchFileSnapshot(
      `__snapshots__/help/${path.join("-")}.txt`,
    );
  });
});

const ENVELOPE = "https://permdock.com/schemas/cli-result-v1.json";

describe("Problem Details under --json", () => {
  it("prints a usage problem on stdout for an unknown command", async () => {
    const result = await run(["nope", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      $schema: ENVELOPE,
      status: "error",
      error: {
        type: "https://permdock.com/docs/cli/errors#unknown_command",
        title: "Unknown command",
        detail: expect.stringContaining("unknown command 'nope'"),
        code: "unknown_command",
        exitCode: 2,
      },
    });
  });

  it("names the command and exits 1 when the database does not answer", async () => {
    const result = await run(
      [
        "rls",
        "verify",
        "--introspect",
        "--db-url-stdin",
        "--json",
        "--cwd",
        FIXTURE,
      ],
      {
        io: {
          stdout: () => undefined,
          stderr: () => undefined,
          readStdin: () =>
            Promise.resolve("postgres://permdock:permdock@127.0.0.1:1/missing"),
        },
      },
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      $schema: ENVELOPE,
      status: "error",
      error: {
        type: "https://permdock.com/docs/cli/errors#database_unreachable",
        title: "Database unreachable",
        detail: "PermDock CLI: rls verify --introspect could not connect",
        code: "database_unreachable",
        command: "rls verify",
        exitCode: 1,
      },
    });
    expect(result.stdout).not.toContain("permdock:permdock@");
  });

  it("wraps a failed check's text report as a failed problem", async () => {
    const cwd = project({
      "permdock.config.ts":
        "export default { permissions: './permissions.ts' };\n",
      "permissions.ts": PERMISSIONS,
    });
    const result = await run(["collect", "--check", "--json", "--cwd", cwd]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      $schema: ENVELOPE,
      status: "error",
      data: {
        out: join(cwd, "permissions.catalog.json"),
        permissions: 9,
        stale: true,
      },
      error: {
        type: "https://permdock.com/docs/cli/errors#check_failed",
        title: "Out of date",
        detail: "catalog missing: permissions.catalog.json",
        code: "check_failed",
        command: "collect",
        exitCode: 1,
      },
    });
  });

  it("wraps a usage result's text as a usage problem", async () => {
    const cwd = project({ "permdock.config.ts": "export default {};\n" });
    const result = await run(["usage", "--json", "--cwd", cwd]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "error",
      error: {
        type: "https://permdock.com/docs/cli/errors#usage",
        command: "usage",
        exitCode: 2,
      },
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
