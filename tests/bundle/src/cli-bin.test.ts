import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "permdock",
);

const run = (...args: readonly string[]) =>
  spawnSync(
    process.execPath,
    [join(PACKAGE, "dist", "cli", "bin.js"), ...args],
    {
      encoding: "utf8",
    },
  );

describe("the built permdock bin", () => {
  it("prints the package version", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(PACKAGE, "package.json"), "utf8"),
    );
    const result = run("--version");
    expect(result.status).toBe(0);
    expect(manifest).toMatchObject({ version: result.stdout.trim() });
  });

  it("prints usage for --help", () => {
    const result = run("--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage  permdock <command>");
  });

  it("answers an unknown command with a cli-result-v1 error under --json", () => {
    const result = run("nope", "--json");
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      $schema: "https://permdock.com/schemas/cli-result-v1.json",
      status: "error",
      error: {
        type: "https://permdock.com/docs/cli/errors#unknown_command",
        code: "unknown_command",
        exitCode: 2,
      },
    });
  });
});
