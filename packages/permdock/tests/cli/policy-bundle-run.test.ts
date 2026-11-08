import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/mini-app");
const dirs: string[] = [];

function out(): string {
  const dir = mkdtempSync(join(tmpdir(), "permdock-bundle-"));
  dirs.push(dir);
  return dir;
}

describe("permdock policy bundle through run", () => {
  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints the bundle to stdout, and the loader SQL with --kind sql", async () => {
    const bundle = await run([
      "policy",
      "bundle",
      "--out",
      "-",
      "--cwd",
      FIXTURE,
    ]);
    expect(bundle.code).toBe(0);
    expect(bundle.stdout).toContain("policy-bundle");
    const sql = await run([
      "policy",
      "bundle",
      "--kind",
      "sql",
      "--out",
      "-",
      "--cwd",
      FIXTURE,
    ]);
    expect(sql.code).toBe(0);
    expect(sql.stdout.toLowerCase()).toContain("insert");
  });

  it("writes a file, plans it on a dry run and reports drift under --check", async () => {
    const file = join(out(), "bundle.json");
    const dry = await run([
      "policy",
      "bundle",
      "--out",
      file,
      "--dry-run",
      "--cwd",
      FIXTURE,
    ]);
    expect(dry.code).toBe(0);
    expect(existsSync(file)).toBe(false);
    const drift = await run([
      "policy",
      "bundle",
      "--out",
      file,
      "--check",
      "--cwd",
      FIXTURE,
    ]);
    expect(drift.code).toBe(1);
    const written = await run([
      "policy",
      "bundle",
      "--out",
      file,
      "--cwd",
      FIXTURE,
    ]);
    expect(written.code).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("policy-bundle");
    expect(
      (
        await run([
          "policy",
          "bundle",
          "--out",
          file,
          "--check",
          "--cwd",
          FIXTURE,
        ])
      ).code,
    ).toBe(0);
  });

  it("needs a policy", async () => {
    const empty = out();
    expect(
      (await run(["policy", "bundle", "--cwd", empty])).code,
    ).toBeGreaterThan(0);
  });
});
