import { readFileSync, writeFileSync } from "node:fs";
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
const version: unknown = JSON.parse(
  readFileSync(join(packageRoot(), "package.json"), "utf8"),
).version;

describe("permdock --version", () => {
  it.each([["--version"], ["-v"]])(
    "prints the package version for %s",
    async (flag) => {
      expect(await run([flag])).toStrictEqual({
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
    await expect(
      stdout.replace(`permdock ${String(version)}:`, "permdock <version>:"),
    ).toMatchFileSnapshot("__snapshots__/help/root.txt");
  });

  it.each(PATHS)("matches the recorded help for %s", async (...path) => {
    const { code, stdout } = await run([...path, "--help", "--no-color"]);
    expect(code).toBe(0);
    await expect(stdout).toMatchFileSnapshot(
      `__snapshots__/help/${path.join("-")}.txt`,
    );
  });
});

const SCHEMA = "https://permdock.com/schemas/cli-result-v2.json";

describe("the cli-result-v2 documents under --json", () => {
  it("prints a usage error as one line on stderr for an unknown command", async () => {
    const result = await run(["nope", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.endsWith("\n")).toBe(true);
    expect(result.stderr.trimEnd()).not.toContain("\n");
    expect(JSON.parse(result.stderr)).toStrictEqual({
      $schema: SCHEMA,
      status: "error",
      reason: "unknown_command",
      message: expect.stringContaining("unknown command 'nope'"),
      type: "https://permdock.com/docs/cli/errors#unknown_command",
      next: [],
      data: {},
      userActionRequired: false,
      retryable: false,
    });
  });

  it("exits 1 with a retryable error when the database does not answer", async () => {
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
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toStrictEqual({
      $schema: SCHEMA,
      status: "error",
      reason: "database_unreachable",
      message: "PermDock CLI: rls verify --introspect could not connect",
      type: "https://permdock.com/docs/cli/errors#database_unreachable",
      next: [],
      data: {},
      userActionRequired: false,
      retryable: true,
    });
    expect(result.stderr).not.toContain("permdock:permdock@");
  });

  it("prints a failed check's report on stdout and its message on stderr", async () => {
    const cwd = project({
      "permdock.config.ts":
        "export default { permissions: './permissions.ts' };\n",
      "permissions.ts": PERMISSIONS,
    });
    const result = await run(["collect", "--check", "--json", "--cwd", cwd]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toStrictEqual({
      $schema: SCHEMA,
      status: "error",
      data: {
        out: join(cwd, "permissions.catalog.json"),
        permissions: 9,
        stale: true,
      },
    });
    expect(result.stderr).toContain(
      "catalog missing: permissions.catalog.json",
    );
  });

  it("reports positionsMoved when only usage lines changed", async () => {
    const use = (above: string) =>
      `import { permissions } from './permissions.ts';\n${above}export const check = (pd: { can(p: unknown): boolean }) => pd.can(permissions.post.read);\n`;
    const cwd = project({
      "permdock.config.ts":
        "export default { permissions: './src/permissions.ts' };\n",
      "src/permissions.ts": PERMISSIONS,
      "src/use.ts": use(""),
    });
    const { code } = await run(["collect", "--cwd", cwd]);
    expect(code).toBe(0);
    writeFileSync(join(cwd, "src/use.ts"), use("\n"));
    const result = await run(["collect", "--check", "--json", "--cwd", cwd]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "success",
      data: { stale: false, positionsMoved: true },
    });
  });

  it("returns catalog's own failure before comparing --out", async () => {
    const cwd = project({ "permdock.config.ts": "export default {};\n" });
    const result = await run([
      "catalog",
      "--out",
      "permissions.md",
      "--check",
      "--cwd",
      cwd,
    ]);
    expect(result.code).toBe(2);
  });

  it("wraps a usage result's text as a usage error", async () => {
    const cwd = project({ "permdock.config.ts": "export default {};\n" });
    const result = await run(["usage", "--json", "--cwd", cwd]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      status: "error",
      reason: "usage",
      type: "https://permdock.com/docs/cli/errors#usage",
    });
  });

  it("keeps a message on stderr without --json", async () => {
    const result = await run(["nope"]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown command 'nope'");
  });
});

describe(usageResult, () => {
  it("reports a usage error and lets a CliError through to run()", () => {
    expect(usageResult(new Error("bad flag"))).toStrictEqual({
      code: 2,
      output: "bad flag",
    });
    expect(usageResult("plain")).toStrictEqual({ code: 2, output: "plain" });
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
