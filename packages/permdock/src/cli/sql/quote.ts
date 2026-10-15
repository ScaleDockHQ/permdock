import type { RlsSqlContext } from "./context.ts";

import {
  quoteQualifiedTable,
  quoteSqlIdent,
  quoteSqlLiteral,
  quoteSqlTable,
} from "../../core/sql.ts";
import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";

export function quoteIdent(name: string): string {
  return quoteSqlIdent(name, CLI);
}

export function quoteTable(name: string): string {
  return quoteSqlTable(name, CLI);
}

/** A table name with `public.` added when it names no schema, quoted. */
export function quoteQualified(name: string): string {
  return quoteQualifiedTable(name, CLI);
}

export function helperSchema(ctx: Pick<RlsSqlContext, "schema">): string {
  return ctx.schema ?? PERMDOCK_SCHEMA;
}

export function qualified(
  ctx: Pick<RlsSqlContext, "schema">,
  name: string,
): string {
  return `${quoteIdent(helperSchema(ctx))}.${name}`;
}

export function quoteLiteral(value: string): string {
  return quoteSqlLiteral(value);
}

export const CLI = "PermDock CLI";

export function declaredArray(values: readonly string[]): string {
  return values.length === 0
    ? `'{}'::text[]`
    : `array[${values.map(quoteLiteral).join(", ")}]::text[]`;
}

/**
 * A text array as a Postgres literal (`'{admin,owner}'`). An element that
 * holds a delimiter, a brace, a quote, a backslash, whitespace, or that
 * reads as `NULL`, is double-quoted and escaped, so one element can never
 * split into several.
 */
export function textArrayLiteral(values: readonly string[]): string {
  const elements = values.map((value) =>
    value === "" || /[\s,{}"\\]/u.test(value) || /^null$/iu.test(value)
      ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
      : value,
  );
  return quoteLiteral(`{${elements.join(",")}}`);
}
