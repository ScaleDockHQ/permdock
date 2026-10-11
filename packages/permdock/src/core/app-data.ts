import type { StandardSchemaV1 } from "@standard-schema/spec";

import { assertSafeKey } from "./paths.ts";
import { validateSync } from "./thenable.ts";

/** A JSON value in an app `x` field. */
export type MetaValue =
  | string
  | number
  | boolean
  | null
  | readonly MetaValue[]
  | { readonly [key: string]: MetaValue };

/** The default shape of an app `x` field: a plain JSON object. */
export type AppData = Readonly<Record<string, MetaValue>>;

/**
 * A Standard Schema for one kind of app data. It must validate synchronously;
 * its output is the type PermDock gives the `x` field it checks.
 */
export type AppDataSchema<X = AppData> = StandardSchemaV1<unknown, X>;

/** A leaf whose `meta.x` is typed by a schema; intersected so it stays assignable to the untyped leaf. */
export type WithX<L, X> = [X] extends [never]
  ? L
  : L & { readonly meta: { readonly x?: Readonly<X> } };

const MAX_META_DEPTH = 8;

/** Throws unless `value` is plain, prototype-safe JSON at most eight levels deep. */
export function assertMetaValue(
  value: unknown,
  label: string,
  depth = 0,
): asserts value is MetaValue {
  if (depth > MAX_META_DEPTH) {
    throw new Error(`PermDock: ${label} nests deeper than ${MAX_META_DEPTH}`);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertMetaValue(item, label, depth + 1);
    }
    return;
  }
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    for (const key of Object.keys(value)) {
      assertSafeKey(key, "meta.x key");
      assertMetaValue(Reflect.get(value, key), label, depth + 1);
    }
    return;
  }
  throw new Error(`PermDock: ${label} must be plain JSON`);
}

/** Throws unless `value` is a plain JSON object (an `x` field). */
export function assertAppData(value: unknown, label: string): void {
  assertMetaValue(value, label, 0);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`PermDock: ${label} must be a JSON object`);
  }
}

type SchemaResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

function runSchema(
  schema: AppDataSchema<unknown>,
  value: unknown,
): SchemaResult {
  const result = validateSync(schema, value);
  if (result.ok) {
    return result;
  }
  return {
    ok: false,
    message:
      result.issues === undefined
        ? "schema must validate synchronously"
        : result.issues.map((issue) => issue.message).join("; "),
  };
}

/**
 * Checks code-declared app data: plain JSON, then the schema when one is
 * given. Throws on failure, because a bad definition is an author error.
 */
export function parseAppData(
  schema: AppDataSchema<unknown> | undefined,
  value: unknown,
  label: string,
): AppData {
  assertAppData(value, label);
  if (schema === undefined) {
    // SAFETY: assertAppData proved value is a plain JSON object.
    return value as AppData;
  }
  const result = runSchema(schema, value);
  if (!result.ok) {
    throw new Error(`PermDock: ${label} is invalid: ${result.message}`);
  }
  assertAppData(result.value, label);
  // SAFETY: assertAppData proved the schema output is a plain JSON object.
  return result.value as AppData;
}

/**
 * Checks app data read from a source (a membership, a stored custom role).
 * Never throws: `undefined` means the value is dropped, and the caller
 * reports it.
 */
export function readAppData(
  schema: AppDataSchema<unknown> | undefined,
  value: unknown,
): AppData | undefined {
  try {
    return parseAppData(schema, value, "x");
  } catch {
    return undefined;
  }
}
