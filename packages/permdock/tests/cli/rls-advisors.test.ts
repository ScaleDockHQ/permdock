import { describe, expect, it } from "vitest";

import type { CliExec } from "../../src/cli/rls-advisors.ts";

import { runRlsAdvisors } from "../../src/cli/rls-advisors.ts";

const ROWS = {
  results: [
    {
      name: "function_search_path_mutable",
      level: "WARN",
      detail: "Function `public.badfn` has a role mutable search_path",
      remediation:
        "https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable",
      cacheKey: "function_search_path_mutable_public_badfn_6ebc",
    },
    {
      name: "extension_versions_outdated",
      level: "INFO",
      detail: "Extension `pg_net` has an update",
      remediation: "https://supabase.com/docs",
      cacheKey: "extension_versions_outdated_pg_net",
    },
  ],
};

function fake(stdout: string, seen: string[][] = []): CliExec {
  return (command, args, options) => {
    seen.push([command, ...args, String(options.env["PATH"])]);
    return { status: 0, stdout, stderr: "" };
  };
}

describe("rls verify --advisors", () => {
  it("runs the security advisors on --db and maps lints to doctor codes", () => {
    const seen: string[][] = [];
    const result = runRlsAdvisors({
      cwd: "/app",
      db: "postgresql://localhost/postgres",
      json: false,
      env: { PATH: "/usr/bin" },
      exec: fake(JSON.stringify(ROWS), seen),
    });
    expect(seen[0]?.slice(0, -1)).toEqual([
      "supabase",
      "db",
      "advisors",
      "--db-url",
      "postgresql://localhost/postgres",
      "--type",
      "security",
      "--output-format",
      "json",
    ]);
    expect(seen[0]?.at(-1)).toMatch(/^\/app\/node_modules\/\.bin.\/usr\/bin$/u);
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "WARN function_search_path_mutable (PD048): Function `public.badfn` has a role mutable search_path",
    );
    expect(result.output).toContain("1 finding(s) at WARN or above");
  });

  it("checks the local stack without --db and passes on INFO rows only", () => {
    const seen: string[][] = [];
    const result = runRlsAdvisors({
      cwd: "/app",
      json: true,
      env: {},
      exec: fake(JSON.stringify({ results: ROWS.results.slice(1) }), seen),
    });
    expect(seen[0]).toContain("--local");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      errors: 0,
      warnings: 0,
      findings: [{ name: "extension_versions_outdated", level: "INFO" }],
    });
  });

  it("prints an install hint when the Supabase CLI is missing", () => {
    const result = runRlsAdvisors({
      cwd: "/app",
      json: false,
      env: {},
      exec: () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: new Error("spawnSync supabase ENOENT"),
      }),
    });
    expect(result).toEqual({
      code: 2,
      output: expect.stringContaining("npm install --save-dev supabase"),
    });
  });

  it("spawns the Supabase CLI from PATH and reports it missing", () => {
    const result = runRlsAdvisors({
      cwd: import.meta.dirname,
      json: false,
      env: {},
    });
    expect(result.code).toBe(2);
    expect(result.output).toContain("npm install --save-dev supabase");
  });

  it.each([
    ["stderr", "boom\n", "supabase db advisors failed: boom"],
    ["the exit status", "", "supabase db advisors failed: exit 3"],
  ])("falls back to %s when stdout is not JSON", (_, stderr, output) => {
    const result = runRlsAdvisors({
      cwd: "/app",
      json: false,
      env: {},
      exec: () => ({ status: 3, stdout: "not json", stderr }),
    });
    expect(result).toEqual({ code: 2, output });
  });

  it("reads missing fields of a malformed row as empty", () => {
    const result = runRlsAdvisors({
      cwd: "/app",
      json: true,
      env: {},
      exec: fake(JSON.stringify({ results: [null] })),
    });
    expect(JSON.parse(result.output)).toMatchObject({
      findings: [{ name: "", level: "" }],
    });
  });

  it("reports the CLI's own error", () => {
    const result = runRlsAdvisors({
      cwd: "/app",
      json: false,
      env: {},
      exec: fake(
        JSON.stringify({
          _tag: "Error",
          error: {
            code: "DbConnectError",
            message: "failed to connect to postgres",
            suggestion: "Set `sslmode=disable`.",
          },
        }),
      ),
    });
    expect(result).toEqual({
      code: 2,
      output:
        "supabase db advisors failed: failed to connect to postgres Set `sslmode=disable`.",
    });
  });
});
