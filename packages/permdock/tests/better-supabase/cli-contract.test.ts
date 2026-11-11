import { Ajv2020 } from "ajv/dist/2020.js";
import { CliError as BetterSupabaseError } from "better-supabase/cli";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { exitCodeOfProblem, PROBLEM_CODES } from "../../src/cli/core/errors.ts";
import { run } from "../../src/cli/core/run.ts";

// The contract both CLIs share (decisions 0037 and 0068): PermDock prints
// better-supabase's CLI contract 3 documents, and every reason it raises is
// one of better-supabase's, with the same exit code.
const require = createRequire(import.meta.url);

function readSchema(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  // SAFETY: the file is a JSON Schema object; ajv rejects anything else when it compiles it
  return parsed as Record<string, unknown>;
}

const upstreamSchema = readSchema(
  require.resolve("better-supabase/schemas/cli-result-v2.json"),
);
// SAFETY: the v2 schema keeps the error document under $defs.error, its codes in `reason`.
const upstreamReasons = new Set(
  (
    upstreamSchema["$defs"] as {
      error: { properties: { reason: { enum: string[] } } };
    }
  ).error.properties.reason.enum,
);

const ajv = new Ajv2020({ allErrors: true, strictRequired: false });
ajv.addFormat("uri", true);
const validate = ajv.compile(upstreamSchema);

function expectUpstream(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  validate(parsed);
  expect(validate.errors ?? []).toStrictEqual([]);
  // SAFETY: the schema just validated it as an object
  return parsed as Record<string, unknown>;
}

describe("the CLI contract shared with better-supabase", () => {
  it("raises only reasons better-supabase's contract lists", () => {
    expect(
      PROBLEM_CODES.filter((code) => !upstreamReasons.has(code)),
    ).toStrictEqual([]);
  });

  it.each(PROBLEM_CODES)("exits on %s as better-supabase does", (code) => {
    // SAFETY: the test above holds every code to the pinned schema's `reason` enum.
    const upstream = new BetterSupabaseError(
      code as ConstructorParameters<typeof BetterSupabaseError>[0],
      "x",
    );
    expect(exitCodeOfProblem(code)).toBe(upstream.exitCode);
  });

  it.each([
    [["catalog", "--kind", "markdown", "--json"], 0],
    [["collect", "--check", "--json"], 1],
  ])(
    "prints %j on stdout as a document better-supabase's v2 schema accepts",
    async (argv, exit) => {
      const { code, stdout } = await run(argv, {
        cwd: new URL("../cli/fixtures/mini-app", import.meta.url).pathname,
      });
      expect(code).toBe(exit);
      expectUpstream(stdout);
    },
  );

  it.each([
    [["nope", "--json"], 2, "error"],
    [["--json"], 2, "error"],
    [["rls", "--json"], 2, "error"],
    [["preset", "decode", "--json"], 2, "action_required"],
    [["codemod", "0.5", "--agent", "yes"], 2, "action_required"],
  ])(
    "prints %j as one stderr line better-supabase's v2 schema accepts",
    async (argv, exit, status) => {
      const { code, stdout, stderr } = await run(argv, {
        cwd: new URL("../cli/fixtures/mini-app", import.meta.url).pathname,
      });
      expect(code).toBe(exit);
      expect(stdout).toBe("");
      expect(stderr.trimEnd()).not.toContain("\n");
      expect(expectUpstream(stderr)).toMatchObject({
        status,
        userActionRequired: status === "action_required",
      });
    },
  );
});
