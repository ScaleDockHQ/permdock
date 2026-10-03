import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  driftOf,
  parseSplit,
  partPath,
  STDOUT,
  writeSqlFiles,
} from "../../src/cli/sql-files.ts";

const TMP = path.join(import.meta.dirname, "../../tmp");
mkdirSync(TMP, { recursive: true });
const cwd = mkdtempSync(path.join(TMP, "rls-sql-files-"));

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("driftOf and writeSqlFiles", () => {
  it("skips stdout files, reports missing and differing ones", () => {
    writeFileSync(path.join(cwd, "same.sql"), "select 1;\n");
    writeFileSync(path.join(cwd, "stale.sql"), "select 1;\nselect 2;\n");
    expect(
      driftOf(cwd, [
        { part: "out", rel: STDOUT, text: "x" },
        { part: "helpers", rel: "same.sql", text: "select 1;\n" },
        { part: "policies", rel: "stale.sql", text: "select 1;\nselect 3;\n" },
        { part: "hook", rel: "nested/missing.sql", text: "x" },
      ]),
    ).toEqual([
      [
        "policies: stale.sql",
        "--- stale.sql (on disk)",
        "+++ stale.sql (generated)",
        "@@ -1,2 +1,2 @@",
        " select 1;",
        "-select 2;",
        "+select 3;",
      ].join("\n"),
      "hook: missing nested/missing.sql",
    ]);
  });

  it("cuts a long diff to 40 lines", () => {
    const lines = (char: string): string =>
      Array.from({ length: 50 }, (_, i) => `select '${char}${i}';\n`).join("");
    writeFileSync(path.join(cwd, "long.sql"), lines("a"));
    const [entry = ""] = driftOf(cwd, [
      { part: "policies", rel: "long.sql", text: lines("b") },
    ]);
    const shown = entry.split("\n");
    expect(shown).toHaveLength(42);
    expect(shown.at(-1)).toBe("… 63 more diff lines");
  });

  it("writes files, creating directories, and returns stdout text", () => {
    const result = writeSqlFiles(cwd, [
      { part: "out", rel: STDOUT, text: "one\n\n" },
      { part: "helpers", rel: "deep/dir/helpers.sql", text: "h" },
      { part: "out", rel: STDOUT, text: "two" },
    ]);
    expect(result).toEqual({
      wrote: ["deep/dir/helpers.sql"],
      printed: "one\ntwo",
    });
    expect(
      driftOf(cwd, [
        { part: "helpers", rel: "deep/dir/helpers.sql", text: "h" },
      ]),
    ).toEqual([]);
  });
});

describe("parseSplit and partPath", () => {
  it.each([
    [undefined, undefined],
    ["hook, helpers", ["helpers", "hook"]],
    ["policies,,", ["policies"]],
    [
      "helpers,views",
      "rls generate --split takes helpers, seeds, indexes, policies and hook, got 'helpers,views'",
    ],
    [
      " , ",
      "rls generate --split takes helpers, seeds, indexes, policies and hook, got ' , '",
    ],
  ])("parses %j", (raw, expected) => {
    expect(parseSplit(raw)).toEqual(expected);
  });

  it("substitutes every {part}", () => {
    expect(partPath("sql/{part}/{part}.sql", "hook")).toBe("sql/hook/hook.sql");
  });
});
