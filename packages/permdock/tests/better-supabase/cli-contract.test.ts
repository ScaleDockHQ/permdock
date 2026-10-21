import { Ajv2020 } from "ajv/dist/2020.js";
import { CliError as BetterSupabaseError } from "better-supabase/cli";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  cliProblem,
  exitCodeOfProblem,
  PROBLEM_CODES,
  type ProblemCode,
} from "../../src/cli/core/errors.ts";
import { run } from "../../src/cli/core/run.ts";

// The contract both CLIs share (decision 0037): a code better-supabase has
// keeps its name, title and exit code here; PermDock adds codes only under
// names better-supabase does not use.
const require = createRequire(import.meta.url);

function upstreamSchema(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(
      require.resolve("better-supabase/schemas/cli-result-v1.json"),
      "utf8",
    ),
  );
  // SAFETY: the published file is a JSON Schema object; ajv rejects anything else when it compiles it
  return parsed as Record<string, unknown>;
}

const schema = upstreamSchema();
// SAFETY: the published schema keeps the problem object under $defs.problem.
const problem = (
  schema["$defs"] as {
    problem: {
      properties: Record<string, unknown> & { code: { enum: string[] } };
    };
  }
).problem;
const upstreamCodes = new Set(problem.properties.code.enum);

/** PermDock's own codes, which better-supabase never uses for another meaning. */
const EXTENSIONS: ReadonlySet<ProblemCode> = new Set([
  "catalog_invalid",
  "dirty_worktree",
  "write_failed",
]);

/**
 * Codes better-supabase adds after the pinned commit; each moves out of here
 * once the pin includes it.
 */
const PENDING_UPSTREAM: ReadonlySet<ProblemCode> = new Set<ProblemCode>();

const shared = PROBLEM_CODES.filter((code) => upstreamCodes.has(code));

const ajv = new Ajv2020({ allErrors: true, strictRequired: false });
ajv.addFormat("uri", true);
const validate = ajv.compile(schema);

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
        !PENDING_UPSTREAM.has(code),
    );
    expect(unexplained).toEqual([]);
  });

  it("keeps the pending list to codes the pinned better-supabase lacks", () => {
    expect(
      [...PENDING_UPSTREAM].filter((code) => upstreamCodes.has(code)),
    ).toEqual([]);
  });

  it.each(shared)("gives %s better-supabase's title and exit code", (code) => {
    // SAFETY: `shared` only holds codes the published schema's enum lists.
    const upstream = new BetterSupabaseError(
      code as ConstructorParameters<typeof BetterSupabaseError>[0],
      "x",
    );
    expect(exitCodeOfProblem(code)).toBe(upstream.exitCode);
    expect(cliProblem("usage", "x", undefined, { code }).title).toBe(
      upstream.problem.title,
    );
  });

  it.each([
    [["nope", "--json"], 2],
    [["--json"], 2],
    [["rls", "--json"], 2],
    [["preset", "decode", "--json"], 3],
  ])(
    "prints %j as an envelope better-supabase's schema accepts",
    async (argv, exit) => {
      const { code, stdout } = await run(argv);
      expect(code).toBe(exit);
      validate(upstreamShape(stdout));
      expect(validate.errors ?? []).toEqual([]);
    },
  );
});
