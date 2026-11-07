import type {
  Condition,
  ConditionRef,
  ConditionValue,
} from "../../conditions/ast.ts";
import type { Scope } from "../../core/scopes.ts";
import type { RlsSqlContext } from "../sql/context.ts";

import { CliError } from "../core/errors.ts";
import { compileConditionSql } from "../sql/conditions.ts";
import { quoteIdent, quoteLiteral } from "../sql/quote.ts";

/** RLS text and the Sync Streams text of one portable condition. */
export type BranchDialects = { readonly rls: string; readonly stream: string };

const STREAM_COMPARE = {
  eq: "=",
  ne: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
} as const;

function contextOf(scopes: readonly Scope[]): RlsSqlContext {
  return {
    dialect: "supabase",
    scopes,
    tenantClaim: scopes[0]?.key ?? "org_id",
    gucPrefix: "app",
  };
}

function literal(value: string | number | boolean | null): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  return quoteLiteral(value);
}

function isPlainValue(
  value: ConditionValue,
): value is string | number | boolean | null {
  return value === null || typeof value !== "object";
}

function isValueList(
  value: readonly ConditionValue[] | ConditionRef,
): value is readonly ConditionValue[] {
  return Array.isArray(value);
}

/**
 * Sync Streams text. `undefined` when the condition needs the RLS compiler's
 * membership or claim context; the caller then reuses the RLS text.
 */
function streamOf(condition: Condition): string | undefined {
  switch (condition.op) {
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return isPlainValue(condition.value)
        ? `${quoteIdent(condition.field)} ${STREAM_COMPARE[condition.op]} ${literal(condition.value)}`
        : undefined;
    case "isNull":
      return `${quoteIdent(condition.field)} IS ${condition.value ? "" : "NOT "}NULL`;
    case "in":
    case "notIn": {
      if (!isValueList(condition.value)) {
        return undefined;
      }
      const values: string[] = [];
      for (const item of condition.value) {
        if (!isPlainValue(item)) {
          return undefined;
        }
        values.push(literal(item));
      }
      const op = condition.op === "in" ? "IN" : "NOT IN";
      return `${quoteIdent(condition.field)} ${op} (${values.join(", ")})`;
    }
    case "and":
    case "or": {
      const parts: string[] = [];
      for (const child of condition.conditions) {
        const part = streamOf(child);
        if (part === undefined) {
          return undefined;
        }
        parts.push(part);
      }
      const joiner = condition.op === "and" ? " AND " : " OR ";
      return `(${parts.join(joiner)})`;
    }
    case "not": {
      const inner = streamOf(condition.condition);
      return inner === undefined ? undefined : `NOT (${inner})`;
    }
    case "sqlFunction":
      return streamOf(condition.twin);
    case "contains":
    case "memberOf":
    case "related":
    case "opaque":
    case "liveSession":
      return undefined;
    default: {
      const never: never = condition;
      return never;
    }
  }
}

/**
 * The default Supabase RLS text and the stream text. `undefined` when the
 * default context cannot compile the condition; the branch keeps the condition
 * and the plugin compiles it with its own options.
 */
export function dialectsFor(
  condition: Condition,
  scopes: readonly Scope[],
): BranchDialects | undefined {
  try {
    const rls = compileConditionSql(condition, contextOf(scopes));
    return { rls, stream: streamOf(condition) ?? rls };
  } catch (error) {
    if (error instanceof CliError) {
      return undefined;
    }
    throw error;
  }
}
