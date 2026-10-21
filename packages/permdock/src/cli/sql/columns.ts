import type { Scope } from "../../core/scopes.ts";
import type { RlsSqlContext } from "./context.ts";

import { byScope } from "../../conditions/compile.ts";
import { isRecord } from "../../core/compact.ts";
import { isForbiddenKey } from "../../core/paths.ts";
import { configError } from "../core/errors.ts";

/**
 * The Postgres type a JSON Schema property compares as; `undefined` for text or
 * an unknown shape.
 */
function columnTypeOf(property: unknown): string | undefined {
  if (!isRecord(property)) {
    return undefined;
  }
  // SAFETY: find(Array.isArray) returns an array or undefined; its items stay unknown.
  const variants = [property["anyOf"], property["oneOf"]].find(
    Array.isArray,
  ) as readonly unknown[] | undefined;
  if (variants !== undefined) {
    const present = variants.filter(
      (item) => !(isRecord(item) && item["type"] === "null"),
    );
    return present.length === 1 ? columnTypeOf(present[0]) : undefined;
  }
  const types = (
    Array.isArray(property["type"]) ? property["type"] : [property["type"]]
  ).filter((item) => item !== "null");
  if (types.length !== 1) {
    return undefined;
  }
  switch (types[0]) {
    case "integer":
    case "number":
      return "numeric";
    case "boolean":
      return "boolean";
    case "string":
      switch (property["format"]) {
        case "date-time":
          return "timestamptz";
        case "date":
          return "date";
        case "uuid":
          return "uuid";
        default:
          return undefined;
      }
    default:
      return undefined;
  }
}

/**
 * Column types from a resource's JSON Schema (`~standard.jsonSchema`): numbers
 * compare as `numeric`, booleans as `boolean`, and `date-time`, `date` and
 * `uuid` strings as `timestamptz`, `date` and `uuid`. Other columns are left
 * out and compare as text.
 */
export function columnTypesOf(
  schema: unknown,
): Readonly<Record<string, string>> {
  const properties = isRecord(schema) ? schema["properties"] : undefined;
  if (!isRecord(properties)) {
    return {};
  }
  const types: Record<string, string> = {};
  for (const [name, property] of Object.entries(properties)) {
    const type = isForbiddenKey(name) ? undefined : columnTypeOf(property);
    if (type !== undefined) {
      types[name] = type;
    }
  }
  return types;
}

/**
 * Array columns from a resource's JSON Schema, each with the type its items
 * compare as (`text` when `columnTypesOf` would leave the item out).
 */
export function arrayColumnsOf(
  schema: unknown,
): Readonly<Record<string, string>> {
  const properties = isRecord(schema) ? schema["properties"] : undefined;
  if (!isRecord(properties)) {
    return {};
  }
  const arrays: Record<string, string> = {};
  for (const [name, property] of Object.entries(properties)) {
    if (isForbiddenKey(name) || !isRecord(property)) {
      continue;
    }
    const types = (
      Array.isArray(property["type"]) ? property["type"] : [property["type"]]
    ).filter((item) => item !== "null");
    if (types.length === 1 && types[0] === "array") {
      arrays[name] = columnTypeOf(property["items"]) ?? "text";
    }
  }
  return arrays;
}

const SQL_TYPE = /^[A-Za-z_][A-Za-z0-9_]*( [A-Za-z_][A-Za-z0-9_]*)*(\[\])?$/u;

export function sqlType(name: string): string {
  if (!SQL_TYPE.test(name)) {
    throw configError(`PermDock CLI: unsafe SQL type '${name}'`);
  }
  return name;
}

export function tenantTypeOf(ctx: RlsSqlContext): string {
  return sqlType(ctx.tenantType ?? "uuid");
}

/**
 * Postgres type of scope `name`'s id: `scopeTypes` by name or by its `tenant` /
 * `team` alias, then the tenant type.
 */
export function scopeTypeOf(ctx: RlsSqlContext, name: string): string {
  const declared = byScope(ctx.scopeTypes, ctx.scopes, name);
  return declared === undefined ? tenantTypeOf(ctx) : sqlType(declared);
}

/**
 * The tenant type `rls.scopeTypes` gives the first scope, else `uuid`: the type
 * the tenant claim and the custom-role tenant arguments are cast to.
 */
export function firstScopeType(
  scopeTypes: Readonly<Record<string, string>> | undefined,
  scopes: readonly Scope[],
): string {
  const first = scopes[0]?.name;
  return (
    (first === undefined ? undefined : byScope(scopeTypes, scopes, first)) ??
    scopeTypes?.["tenant"] ??
    "uuid"
  );
}
