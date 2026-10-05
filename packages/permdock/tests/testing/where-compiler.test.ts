import { describe } from "vitest";

import { toWhere as drizzleToWhere } from "../../src/drizzle/index.ts";
import { toWhere as kyselyToWhere } from "../../src/kysely/index.ts";
import { toWhere as prismaToWhere } from "../../src/prisma/index.ts";
import { testWhereCompiler } from "../../src/testing/conformance.ts";

type Row = Readonly<Record<string, unknown>>;
type Truth = boolean | null;

const COLUMNS = {
  id: "id",
  authorId: "authorId",
  score: "score",
  title: "title",
  archived: "archived",
  note: "note",
  orgId: "orgId",
};

function record(value: unknown): Readonly<Record<string, unknown>> {
  // SAFETY: every node the stubs and Prisma build is a plain object; fields are read and compared only.
  return value as Readonly<Record<string, unknown>>;
}

/** Postgres `LIKE` with `\` as the escape character. */
function like(value: unknown, pattern: string): Truth {
  if (value === null || value === undefined) {
    return null;
  }
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "\\") {
      index += 1;
      source += RegExp.escape(pattern[index] ?? "");
    } else if (char === "%") {
      source += ".*";
    } else if (char === "_") {
      source += ".";
    } else {
      source += RegExp.escape(char);
    }
  }
  return new RegExp(`^${source}$`, "su").test(String(value));
}

function compareTruth(op: string, left: unknown, right: unknown): Truth {
  if (left === null || left === undefined) {
    return null;
  }
  // SAFETY: fixture values are strings, numbers and booleans, which compare with < and >.
  const a = left as number;
  // SAFETY: as above, for the operand.
  const b = right as number;
  switch (op) {
    case "eq":
    case "equals":
      return a === b;
    case "ne":
    case "not":
      return a !== b;
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
    default:
      throw new Error(`no comparison ${op}`);
  }
}

function allTruth(values: readonly Truth[]): Truth {
  if (values.includes(false)) {
    return false;
  }
  return values.includes(null) ? null : true;
}

function anyTruth(values: readonly Truth[]): Truth {
  if (values.includes(true)) {
    return true;
  }
  return values.includes(null) ? null : false;
}

function notTruth(value: Truth): Truth {
  return value === null ? null : !value;
}

/** Runs the expression the Drizzle operator stubs below build. */
function drizzleTruth(node: unknown, row: Row): Truth {
  const { op, args, value, column, values, sql } = record(node);
  const cell = typeof column === "string" ? row[column] : undefined;
  switch (op) {
    case "and":
      // SAFETY: the and and or stubs keep their arguments as an array.
      return allTruth((args as unknown[]).map((arg) => drizzleTruth(arg, row)));
    case "or":
      // SAFETY: as above.
      return anyTruth((args as unknown[]).map((arg) => drizzleTruth(arg, row)));
    case "not":
      return notTruth(drizzleTruth(value, row));
    case "isNull":
      return cell === null;
    case "isNotNull":
      return cell !== null;
    case "like":
      return like(cell, String(value));
    case "inArray":
      // SAFETY: the inArray stub keeps its values as an array.
      return cell === null ? null : (values as unknown[]).includes(cell);
    case "notInArray":
      // SAFETY: as above.
      return cell === null ? null : !(values as unknown[]).includes(cell);
    case "sql":
      if (sql === "true" || sql === "false") {
        return sql === "true";
      }
      throw new Error(`no SQL ${String(sql)}`);
    default:
      return compareTruth(String(op), cell, value);
  }
}

/** Runs a Prisma `where` the way its Postgres connector translates it. */
function prismaTruth(where: unknown, row: Row): Truth {
  const parts: Truth[] = [];
  for (const [key, value] of Object.entries(record(where))) {
    if (key === "AND") {
      // SAFETY: toWhere builds AND and OR as arrays.
      parts.push(
        allTruth((value as unknown[]).map((item) => prismaTruth(item, row))),
      );
    } else if (key === "OR") {
      // SAFETY: as above.
      parts.push(
        anyTruth((value as unknown[]).map((item) => prismaTruth(item, row))),
      );
    } else if (key === "NOT") {
      parts.push(notTruth(prismaTruth(value, row)));
    } else {
      const cell = row[key];
      for (const [op, operand] of Object.entries(record(value))) {
        if (operand === null) {
          parts.push(op === "equals" ? cell === null : cell !== null);
        } else if (op === "in" || op === "notIn") {
          // SAFETY: toWhere builds in and notIn with an array operand.
          const found = (operand as unknown[]).includes(cell);
          parts.push(cell === null ? null : op === "in" ? found : !found);
        } else if (op === "contains") {
          parts.push(like(cell, `%${String(operand)}%`));
        } else {
          parts.push(compareTruth(op, cell, operand));
        }
      }
    }
  }
  return allTruth(parts);
}

/** Runs a Kysely `where` callback against a builder that evaluates as it builds. */
function kyselyTruth(compiled: unknown, row: Row): Truth {
  const cellOf = (operand: unknown): unknown => {
    const { ref } = record(operand);
    return row[String(ref).split(".").at(-1) ?? ""];
  };
  const valueOf = (operand: unknown): unknown =>
    operand !== null && typeof operand === "object" && "val" in operand
      ? operand.val
      : operand;
  const OPS: Readonly<Record<string, string>> = {
    "=": "eq",
    "!=": "ne",
    ">": "gt",
    ">=": "gte",
    "<": "lt",
    "<=": "lte",
  };
  const eb = Object.assign(
    (left: unknown, op: string, right: unknown): Truth => {
      const cell = cellOf(left);
      const value = valueOf(right);
      switch (op) {
        case "is":
          return cell === null;
        case "is not":
          return cell !== null;
        case "like":
          return like(cell, String(value));
        case "in":
        case "not in": {
          // SAFETY: toWhere passes in and not in a list of values.
          const found = (value as unknown[]).includes(cell);
          return cell === null ? null : op === "in" ? found : !found;
        }
        default:
          return compareTruth(OPS[op] ?? op, cell, value);
      }
    },
    {
      and: (items: readonly Truth[]) => allTruth(items),
      or: (items: readonly Truth[]) => anyTruth(items),
      not: (item: Truth) => notTruth(item),
      lit: (value: boolean) => value,
      val: (value: unknown) => ({ val: value }),
      ref: (name: string) => ({ ref: name }),
    },
  );
  // SAFETY: kysely's toWhere returns a callback that takes the expression builder.
  return (compiled as (builder: typeof eb) => Truth)(eb);
}

describe("testWhereCompiler drizzle", () => {
  const posts = COLUMNS;
  testWhereCompiler(
    (condition, table) =>
      drizzleToWhere(condition, table, {
        operators: {
          and: (...args: unknown[]) => ({ op: "and", args }),
          or: (...args: unknown[]) => ({ op: "or", args }),
          not: (value: unknown) => ({ op: "not", value }),
          eq: (column: unknown, value: unknown) => ({
            op: "eq",
            column,
            value,
          }),
          ne: (column: unknown, value: unknown) => ({
            op: "ne",
            column,
            value,
          }),
          gt: (column: unknown, value: unknown) => ({
            op: "gt",
            column,
            value,
          }),
          gte: (column: unknown, value: unknown) => ({
            op: "gte",
            column,
            value,
          }),
          lt: (column: unknown, value: unknown) => ({
            op: "lt",
            column,
            value,
          }),
          lte: (column: unknown, value: unknown) => ({
            op: "lte",
            column,
            value,
          }),
          inArray: (column: unknown, values: readonly unknown[]) => ({
            op: "inArray",
            column,
            values,
          }),
          notInArray: (column: unknown, values: readonly unknown[]) => ({
            op: "notInArray",
            column,
            values,
          }),
          isNull: (column: unknown) => ({ op: "isNull", column }),
          isNotNull: (column: unknown) => ({ op: "isNotNull", column }),
          like: (column: unknown, value: unknown) => ({
            op: "like",
            column,
            value,
          }),
          sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
            op: "sql",
            sql: strings.join("?"),
            values,
          }),
        },
      }),
    {
      target: posts,
      isFailClosed: (compiled) =>
        compiled !== null &&
        typeof compiled === "object" &&
        "op" in compiled &&
        compiled.op === "sql" &&
        "sql" in compiled &&
        compiled.sql === "false",
      matches: (compiled, row) => drizzleTruth(compiled, row) === true,
    },
  );
});

describe("testWhereCompiler prisma", () => {
  testWhereCompiler((condition) => prismaToWhere(condition), {
    target: {},
    isFailClosed: (compiled) =>
      compiled !== null &&
      typeof compiled === "object" &&
      "OR" in compiled &&
      Array.isArray(compiled.OR) &&
      compiled.OR.length === 0,
    matches: (compiled, row) => prismaTruth(compiled, row) === true,
  });
});

describe("testWhereCompiler kysely", () => {
  testWhereCompiler((condition, table) => kyselyToWhere(condition, table), {
    target: "posts",
    isFailClosed: (compiled) => kyselyTruth(compiled, {}) === false,
    matches: (compiled, row) => kyselyTruth(compiled, row) === true,
  });
});
