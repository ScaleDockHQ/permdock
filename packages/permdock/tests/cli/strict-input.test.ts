import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isCi } from "../../src/cli/core/env.ts";
import { exitCodeOf } from "../../src/cli/core/errors.ts";
import { run } from "../../src/cli/core/run.ts";
import { runDoctor } from "../../src/cli/doctor/doctor.ts";

const dirs: string[] = [];

function dir(): string {
  const path = mkdtempSync(join(tmpdir(), "permdock-strict-"));
  dirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of dirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("unknown flags", () => {
  it("exits 2 and suggests the nearest flag", async () => {
    const result = await run(["config", "--jsn"], { cwd: dir() });
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr:
        "config: unknown flag '--jsn'. Did you mean --json? Run permdock config --help for the flags it takes.\n",
    });
  });

  it("prints a usage problem under --json", async () => {
    const result = await run(["config", "--json", "--frobnicate"], {
      cwd: dir(),
    });
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "error",
      error: {
        type: "https://permdock.com/docs/cli/errors#unknown_flag",
        code: "unknown_flag",
        command: "config",
        exitCode: 2,
      },
    });
  });
});

describe("--cwd", () => {
  it("rejects an empty value and a path that is not a directory", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "file.txt"), "");
    expect(await run(["config", "--cwd", ""], { cwd })).toMatchObject({
      code: 2,
      stderr: "--cwd needs a directory\n",
    });
    expect(await run(["config", "--cwd", "file.txt"], { cwd })).toMatchObject({
      code: 2,
      stderr: `--cwd ${join(cwd, "file.txt")} is not a directory\n`,
    });
    expect((await run(["config", "--cwd", "missing"], { cwd })).code).toBe(2);
  });
});

describe("isCi", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["0", false],
    ["false", false],
    ["FALSE", false],
    ["true", true],
    ["1", true],
  ])("CI=%s is %s", (value, expected) => {
    expect(isCi({ CI: value })).toBe(expected);
  });
});

describe("exit codes", () => {
  it("maps a cancelled run to 130", () => {
    expect(exitCodeOf("cancelled")).toBe(130);
    expect(exitCodeOf("usage")).toBe(2);
    expect(exitCodeOf("failed")).toBe(1);
  });
});

describe("value checks", () => {
  it("rejects an unknown --authorize value", async () => {
    const result = await run(["rls", "generate", "--authorize", "jwk"], {
      cwd: dir(),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      "rls generate: --authorize 'jwk' is not one of database, jwt. Did you mean jwt?\n",
    );
  });

  it("rejects an init id outside the catalogue and suggests the nearest", async () => {
    const result = await run(
      ["init", "--archetype", "b2b", "--framework", "nxt", "--dry-run"],
      { cwd: dir() },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      "init: --framework 'nxt' is not one of next, hono, express, none. Did you mean next?\n",
    );
  });

  it("rejects an unknown doctor --only value with a suggestion", async () => {
    const result = await runDoctor({
      cwd: dir(),
      config: {},
      only: ["PD00"],
      json: false,
      fix: false,
      strict: false,
      color: false,
      now: new Date(0),
      io: { stdout: () => undefined, stderr: () => undefined },
    });
    expect(result.code).toBe(2);
    expect(result.output).toMatch(
      /^doctor: --only pd00 names no check code or group\. Did you mean pd0\d\d\?$/u,
    );
  });
});
