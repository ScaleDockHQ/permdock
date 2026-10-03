import { describe, expect, it } from "vitest";

import { group, sqlStatements } from "../../src/cli/sql-statements.ts";

describe("sqlStatements", () => {
  it("keeps an unterminated string or dollar-quoted body as the last statement", () => {
    expect(sqlStatements("select 1;\nselect 'open; still open")).toEqual([
      { line: 1, text: "select 1" },
      { line: 2, text: "select 'open; still open" },
    ]);
    expect(
      sqlStatements("select 1;\ncreate function f() as $body$ select 2;"),
    ).toEqual([
      { line: 1, text: "select 1" },
      { line: 2, text: "create function f() as $body$ select 2;" },
    ]);
  });
});

describe("group", () => {
  it("reads an optional group that took no part as empty", () => {
    const match = /^(a)(b)?$/u.exec("a");
    expect(match === null ? undefined : group(match, 2)).toBe("");
  });
});
