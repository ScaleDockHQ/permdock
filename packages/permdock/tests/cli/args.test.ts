import { describe, expect, it } from "vitest";

import { didYouMean, parseLeaf } from "../../src/cli/core/args.ts";
import { CliError } from "../../src/cli/core/errors.ts";

const FLAGS = {
  json: { type: "boolean", description: "" },
  yes: { type: "boolean", alias: "y", description: "" },
  open: { type: "boolean", default: true, description: "" },
  out: { type: "string", description: "" },
  src: { type: "string", repeatable: true, description: "" },
  kind: { type: "enum", options: ["node", "pgtap"], description: "" },
} as const;

function problem(run: () => unknown): CliError {
  try {
    run();
  } catch (error) {
    if (error instanceof CliError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a CliError");
}

describe(parseLeaf, () => {
  it("reads aliases, negations, = values, repeated and comma-split values", () => {
    const input = parseLeaf(
      "x",
      [
        "-y",
        "--no-open",
        "--out=a.sql",
        "--src",
        "a, b",
        "--src=c",
        "--kind",
        "pgtap",
      ],
      FLAGS,
    );
    expect(input.flags).toStrictEqual({
      json: false,
      yes: true,
      open: false,
      out: "a.sql",
      src: ["a", "b", "c"],
      kind: "pgtap",
    });
  });

  it("applies defaults and reads a bare string flag as empty", () => {
    expect(parseLeaf("x", ["--out"], FLAGS).flags).toMatchObject({
      open: true,
      out: "",
      src: [],
    });
  });

  it("keeps everything after -- as passthrough", () => {
    expect(
      parseLeaf("x", ["--json", "--", "--other", "-z"], FLAGS),
    ).toMatchObject({ passthrough: ["--other", "-z"] });
  });

  it("rejects an unknown flag with the nearest name", () => {
    const error = problem(() => parseLeaf("x", ["--jsn"], FLAGS));
    expect(error.code).toBe("unknown_flag");
    expect(error.message).toContain("Did you mean --json?");
  });

  it("rejects an enum value outside its options", () => {
    const error = problem(() => parseLeaf("x", ["--kind", "tap"], FLAGS));
    expect(error.code).toBe("invalid_value");
    expect(error.message).toContain("node, pgtap");
  });

  it("binds positionals and rejects a missing or extra one", () => {
    const positionals = [
      { name: "version", description: "", required: true },
      { name: "paths", description: "", variadic: true },
    ];
    expect(parseLeaf("x", ["0.5", "a", "b"], {}, positionals)).toMatchObject({
      args: { version: "0.5", paths: "a" },
      rest: ["a", "b"],
    });
    expect(problem(() => parseLeaf("x", [], {}, positionals)).code).toBe(
      "input_required",
    );
    expect(problem(() => parseLeaf("x", ["extra"], {})).code).toBe("usage");
  });
});

describe(didYouMean, () => {
  it("suggests only a close name", () => {
    expect(didYouMean("--chek", ["--check", "--json"])).toBe("--check");
    expect(didYouMean("--zzzzzz", ["--check", "--json"])).toBeUndefined();
  });
});
