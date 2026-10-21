import { expect, it } from "vitest";

import type { Condition } from "../../conditions/ast.ts";
import type { Subject, WhereCompiler } from "../../index.ts";

import { evaluateCondition } from "../../conditions/evaluate.ts";

type WhereRow = Readonly<Record<string, unknown>>;

const WHERE_ROWS: readonly WhereRow[] = [
  {
    id: "r1",
    authorId: "u1",
    score: 5,
    title: "Plan 100%",
    archived: false,
    note: null,
  },
  {
    id: "r2",
    authorId: "u2",
    score: 10,
    title: "plan_b",
    archived: true,
    note: "kept",
  },
  {
    id: "r3",
    authorId: null,
    score: null,
    title: null,
    archived: null,
    note: null,
  },
];

const WHERE_CASES: readonly (readonly [name: string, condition: Condition])[] =
  [
    ["eq", { op: "eq", field: "authorId", value: "u1" }],
    ["ne", { op: "ne", field: "authorId", value: "u1" }],
    ["eq on a boolean", { op: "eq", field: "archived", value: false }],
    ["gt", { op: "gt", field: "score", value: 5 }],
    ["gte", { op: "gte", field: "score", value: 5 }],
    ["lt", { op: "lt", field: "score", value: 10 }],
    ["lte", { op: "lte", field: "score", value: 10 }],
    ["contains a literal %", { op: "contains", field: "title", value: "100%" }],
    ["contains a literal _", { op: "contains", field: "title", value: "n_b" }],
    ["in", { op: "in", field: "authorId", value: ["u1", "u2"] }],
    ["notIn", { op: "notIn", field: "authorId", value: ["u1"] }],
    ["isNull", { op: "isNull", field: "note", value: true }],
    ["is not null", { op: "isNull", field: "note", value: false }],
    [
      "and",
      {
        op: "and",
        conditions: [
          { op: "eq", field: "authorId", value: "u1" },
          { op: "lt", field: "score", value: 10 },
        ],
      },
    ],
    [
      "or",
      {
        op: "or",
        conditions: [
          { op: "eq", field: "authorId", value: "u1" },
          { op: "eq", field: "archived", value: true },
        ],
      },
    ],
    [
      "not over a NULL field",
      { op: "not", condition: { op: "eq", field: "authorId", value: "u1" } },
    ],
    [
      "not over and",
      {
        op: "not",
        condition: {
          op: "and",
          conditions: [
            { op: "eq", field: "authorId", value: "u2" },
            { op: "gt", field: "score", value: 5 },
          ],
        },
      },
    ],
    ["and of nothing", { op: "and", conditions: [] }],
    [
      "not of the empty allow set",
      { op: "not", condition: { op: "or", conditions: [] } },
    ],
  ];

const WHERE_SUBJECT: Subject = { principal: null, context: {} };

/**
 * `matches` answers whether the compiled output selects `row`, for example by
 * running it against a table holding only that row. With it, every case must
 * select the rows the in-memory evaluator keeps, including rows whose fields
 * are NULL.
 */
export function testWhereCompiler<TTarget>(
  compiler: WhereCompiler<TTarget>,
  options: {
    readonly target: TTarget;
    readonly isFailClosed?: (compiled: unknown) => boolean;
    readonly matches?: (
      compiled: unknown,
      row: WhereRow,
    ) => boolean | Promise<boolean>;
  },
): void {
  const { matches } = options;
  it.skipIf(matches === undefined).each(WHERE_CASES)(
    "selects the rows the evaluator keeps: %s",
    async (_name, condition) => {
      if (matches === undefined) {
        return;
      }
      const compiled = compiler(condition, options.target);
      const selected: unknown[] = [];
      for (const row of WHERE_ROWS) {
        if (await matches(compiled, row)) {
          selected.push(row["id"]);
        }
      }
      expect(selected).toEqual(
        WHERE_ROWS.filter((row) =>
          evaluateCondition(condition, row, WHERE_SUBJECT),
        ).map((row) => row["id"]),
      );
    },
  );

  it("fails closed on an empty allow set", () => {
    const compiled = compiler({ op: "or", conditions: [] }, options.target);
    const closed =
      options.isFailClosed === undefined
        ? compiled === false || compiled === undefined || compiled === null
        : options.isFailClosed(compiled);
    expect(closed).toBe(true);
  });

  it("compiles a sqlFunction through its twin", () => {
    const twin = { op: "eq" as const, field: "authorId", value: "u1" };
    expect(() =>
      compiler(
        {
          op: "sqlFunction",
          name: "job_permitted",
          args: [{ field: "id" }],
          twin,
        },
        options.target,
      ),
    ).not.toThrow();
  });
}
