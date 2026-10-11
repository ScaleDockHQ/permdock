import type { StandardSchemaV1 } from "@standard-schema/spec";

import { isRecord } from "./compact.ts";

export function isThenable<T>(
  value: T | PromiseLike<T>,
): value is PromiseLike<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/** Settles a promise nobody awaits, so its rejection is not reported as unhandled. */
export function ignoreRejection(value: PromiseLike<unknown>): void {
  void Promise.resolve(value).then(undefined, () => undefined);
}

export type SyncValidation =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      /** Absent when the schema answered asynchronously. */
      readonly issues?: readonly StandardSchemaV1.Issue[];
    };

/** Runs a Standard Schema that must answer synchronously; an asynchronous answer fails. */
export function validateSync(
  schema: StandardSchemaV1,
  value: unknown,
): SyncValidation {
  const result = schema["~standard"].validate(value);
  if (isThenable(result)) {
    ignoreRejection(result);
    return { ok: false };
  }
  return result.issues === undefined
    ? { ok: true, value: result.value }
    : { ok: false, issues: result.issues };
}

/** `validateSync` for a schema whose output must be an object; anything else is `undefined`. */
export function validateRecord(
  schema: StandardSchemaV1,
  value: unknown,
): Record<string, unknown> | undefined {
  const validated = validateSync(schema, value);
  return validated.ok && isRecord(validated.value)
    ? validated.value
    : undefined;
}
