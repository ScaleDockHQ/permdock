import { Ajv2020 } from "ajv/dist/2020.js";
import { CliError as BetterSupabaseError } from "better-supabase/cli";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import type { ProblemCode } from "../../src/cli/core/errors.ts";

import {
  cliProblem,
  exitCodeOfProblem,
  PROBLEM_CODES,
} from "../../src/cli/core/errors.ts";
import { run } from "../../src/cli/core/run.ts";

// The contract both CLIs share (decision 0037): a code better-supabase has
// keeps its name and title here; PermDock adds codes only under names
// better-supabase does not use. better-supabase 0.58 moved to CLI contract 3
// and PermDock stays on the `cli-result-v1` envelope (decision 0068), so the
// envelope is checked against the last v1 schema better-supabase published
// (0.57.0) and the codes against the pinned release.
const require = createRequire(import.meta.url);

function readSchema(path: string | URL): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  // SAFETY: both files are JSON Schema objects; ajv rejects anything else when it compiles them
  return parsed as Record<string, unknown>;
}

const envelopeSchema = readSchema(
  new URL("../fixtures/better-supabase/cli-result-v1.json", import.meta.url),
);
// SAFETY: the v1 schema keeps the problem object under $defs.problem.
const problem = (
  envelopeSchema["$defs"] as {
    problem: { properties: Record<string, unknown> };
  }
).problem;

const pinnedSchema = readSchema(
  require.resolve("better-supabase/schemas/cli-result-v2.json"),
);
// SAFETY: the v2 schema keeps the error document under $defs.error, its codes in `reason`.
const pinnedError = (
  pinnedSchema["$defs"] as {
    error: { properties: { reason: { enum: string[] } } };
  }
).error;
const upstreamCodes = new Set(pinnedError.properties.reason.enum);

/** PermDock's own codes, which better-supabase never uses for another meaning. */
const EXTENSIONS: ReadonlySet<ProblemCode> = new Set([
  "catalog_invalid",
  "dirty_worktree",
  "write_failed",
]);

/** Codes contract 3 renamed, PermDock's name to better-supabase's. */
const RENAMED_UPSTREAM: ReadonlyMap<ProblemCode, string> = new Map([
  ["consent_required", "confirmation_required"],
]);

/**
 * Codes that exit 3 in PermDock, where contract 3 exits 2 with
 * `userActionRequired: true`.
 */
const ACTION_REQUIRED: ReadonlySet<ProblemCode> = new Set([
  "auth_required",
  "input_required",
]);

/**
 * Codes better-supabase adds after the pinned commit; each moves out of here
 * once the pin includes it.
 */
const PENDING_UPSTREAM: ReadonlySet<ProblemCode> = new Set<ProblemCode>();

const shared = PROBLEM_CODES.filter((code) => upstreamCodes.has(code));

const ajv = new Ajv2020({ allErrors: true, strictRequired: false });
ajv.addFormat("uri", true);
const validate = ajv.compile(envelopeSchema);

/**
 * The envelope with only the problem members better-supabase defines, so
 * PermDock's extensions don't count.
 */
function upstreamShape(stdout: string): unknown {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null) {
    return parsed;
  }
  const error: unknown = Reflect.get(parsed, "error");
  if (typeof error !== "object" || error === null) {
    return parsed;
  }
  const known = Object.entries(error).filter(([key]) =>
    Object.hasOwn(problem.properties, key),
  );
  return { ...parsed, error: Object.fromEntries(known) };
}

describe("the CLI contract shared with better-supabase", () => {
  it("names every code better-supabase has, or declares it PermDock's own", () => {
    const unexplained = PROBLEM_CODES.filter(
      (code) =>
        !upstreamCodes.has(code) &&
        !EXTENSIONS.has(code) &&
        !RENAMED_UPSTREAM.has(code) &&
        !PENDING_UPSTREAM.has(code),
    );
    expect(unexplained).toStrictEqual([]);
  });

  it("keeps the pending list to codes the pinned better-supabase lacks", () => {
    expect(
      [...PENDING_UPSTREAM].filter((code) => upstreamCodes.has(code)),
    ).toStrictEqual([]);
  });

  it.each([...RENAMED_UPSTREAM])(
    "keeps %s, which the pinned better-supabase names %s",
    (code, renamed) => {
      expect(upstreamCodes.has(code)).toBe(false);
      expect(upstreamCodes.has(renamed)).toBe(true);
    },
  );

  it.each(shared)("gives %s better-supabase's title and exit code", (code) => {
    // SAFETY: `shared` only holds codes the pinned schema's `reason` enum lists.
    const upstream = new BetterSupabaseError(
      code as ConstructorParameters<typeof BetterSupabaseError>[0],
      "x",
    );
    expect(cliProblem("usage", "x", undefined, { code }).title).toBe(
      upstream.problem.title,
    );
    expect(exitCodeOfProblem(code)).toBe(
      ACTION_REQUIRED.has(code) ? 3 : upstream.exitCode,
    );
  });

  it.each([...ACTION_REQUIRED])(
    "exits 3 on %s, where contract 3 exits 2",
    (code) => {
      // SAFETY: better-supabase's constructor throws on a code its contract lacks, which fails the test.
      const upstream = new BetterSupabaseError(
        code as ConstructorParameters<typeof BetterSupabaseError>[0],
        "x",
      );
      expect(upstream.exitCode).toBe(2);
      expect(exitCodeOfProblem(code)).toBe(3);
    },
  );

  it.each([
    [["nope", "--json"], 2],
    [["--json"], 2],
    [["rls", "--json"], 2],
    [["preset", "decode", "--json"], 3],
  ])(
    "prints %j as an envelope better-supabase's v1 schema accepts",
    async (argv, exit) => {
      const { code, stdout } = await run(argv);
      expect(code).toBe(exit);
      validate(upstreamShape(stdout));
      expect(validate.errors ?? []).toStrictEqual([]);
    },
  );
});
