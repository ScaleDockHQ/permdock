import { describe } from "vitest";

import type { CompiledWhere } from "../../src/compile/index.ts";

import { compileWhere } from "../../src/compile/index.ts";
import { testWhereCompiler } from "../../src/testing/index.ts";

type Truth = boolean | null;

function compare(
  node: Extract<CompiledWhere, { readonly kind: "compare" }>,
  value: unknown,
): Truth {
  if (value === null || value === undefined) {
    return null;
  }
  // SAFETY: the fixture rows and operands are strings, numbers and booleans, which compare with < and >.
  const left = value as number;
  // SAFETY: as above, for the operand.
  const right = node.value as number;
  switch (node.op) {
    case "eq":
      return left === right;
    case "ne":
      return left !== right;
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "contains":
      return String(value).includes(String(node.value));
    case "in":
      return Array.isArray(node.value) && node.value.includes(value);
    case "notIn":
      return Array.isArray(node.value) && !node.value.includes(value);
    default: {
      const exhaustive: never = node.op;
      return exhaustive;
    }
  }
}

/** Postgres three-valued logic: a comparison against NULL is unknown. */
function truth(
  node: CompiledWhere,
  row: Readonly<Record<string, unknown>>,
): Truth {
  switch (node.kind) {
    case "never":
      return false;
    case "always":
      return true;
    case "compare":
      return compare(node, row[node.field]);
    case "isNull": {
      const missing = row[node.field] === null;
      return node.negated ? !missing : missing;
    }
    case "and": {
      const values = new Set(node.items.map((item) => truth(item, row)));
      if (values.has(false)) {
        return false;
      }
      return values.has(null) ? null : true;
    }
    case "or": {
      const values = new Set(node.items.map((item) => truth(item, row)));
      if (values.has(true)) {
        return true;
      }
      return values.has(null) ? null : false;
    }
    case "not": {
      const value = truth(node.item, row);
      return value === null ? null : !value;
    }
    case "exists":
    case "sql":
      throw new Error(`no table to run a ${node.kind} node against`);
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

describe("permdock/compile compileWhere", () => {
  testWhereCompiler((condition) => compileWhere(condition), {
    target: undefined,
    isFailClosed: (compiled) =>
      typeof compiled === "object" &&
      compiled !== null &&
      "kind" in compiled &&
      compiled.kind === "never",
    matches: (compiled, row) =>
      // SAFETY: compileWhere returns a CompiledWhere.
      truth(compiled as CompiledWhere, row) === true,
  });
});
