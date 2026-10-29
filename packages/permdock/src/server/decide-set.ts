import type { Decision } from "../core/decision.ts";
import type { Permission } from "../core/permission-types.ts";

type Granted = Extract<Decision, { readonly outcome: "granted" }>;
type Refused = Exclude<Decision, { readonly outcome: "granted" }>;

/** `decide` of one permission for each row, in row order. */
export type DecideRows = (
  permission: Permission,
  rows: readonly unknown[],
) => Promise<readonly Decision[]>;

export type SetDecision =
  | { readonly ok: true; readonly decision: Granted }
  | {
      readonly ok: false;
      readonly decision: Refused;
      /** The permission whose refusal is reported. */
      readonly permission: Permission;
      /** The first refused row. */
      readonly row: unknown;
    };

/** The permissions `protect` takes: one, or a non-empty list. */
export function permissionList(
  permission: Permission | readonly Permission[],
): readonly Permission[] {
  const list: readonly Permission[] = Array.isArray(permission)
    ? permission
    : [permission];
  if (list.length === 0) {
    throw new TypeError(
      "PermDock: protect takes a permission or a non-empty list of permissions",
    );
  }
  return list;
}

export type SetOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | {
      readonly ok: false;
      /** `undefined` when `decide` answered too few results. */
      readonly result: T | undefined;
      readonly permission: Permission;
      readonly row: unknown;
    };

/**
 * Decides `permissions` over `rows`: every row needs every permission, or with
 * `anyOf` one of them. Under `anyOf`, a permission decides only the rows the
 * earlier ones refused, so a limit is consumed once per granted row, and a
 * refusal reports the first permission's result. An all-of check stops at the
 * first permission that refuses a row. No rows refuses.
 */
export async function decideAll<T>(
  permissions: readonly Permission[],
  rows: readonly unknown[],
  anyOf: boolean,
  decide: (
    permission: Permission,
    rows: readonly unknown[],
  ) => Promise<readonly T[]>,
  granted: (result: T) => boolean,
): Promise<SetOutcome<T>> {
  const lead = permissions[0] ?? noPermission();
  let first: T | undefined;
  if (anyOf) {
    let pending = rows.map((row, index) => ({ row, index }));
    let firstResults: readonly T[] = [];
    for (const [order, permission] of permissions.entries()) {
      // A permission decides only the rows the earlier ones refused.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const results = await decide(
        permission,
        pending.map((entry) => entry.row),
      );
      if (order === 0) {
        firstResults = results;
      }
      const still: typeof pending = [];
      for (const [position, entry] of pending.entries()) {
        const result = results[position];
        if (result !== undefined && granted(result)) {
          first ??= result;
        } else {
          still.push(entry);
        }
      }
      pending = still;
      if (pending.length === 0) {
        break;
      }
    }
    const [head] = pending;
    if (head !== undefined) {
      const result = firstResults[head.index];
      return {
        ok: false,
        result: result === undefined || granted(result) ? undefined : result,
        permission: lead,
        row: head.row,
      };
    }
  } else {
    for (const permission of permissions) {
      // A later permission is not asked once an earlier one refuses.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const results = await decide(permission, rows);
      for (const [index, row] of rows.entries()) {
        const result = results[index];
        if (result === undefined || !granted(result)) {
          return { ok: false, result, permission, row };
        }
        first ??= result;
      }
    }
  }
  return first === undefined
    ? { ok: false, result: undefined, permission: lead, row: rows[0] }
    : { ok: true, result: first };
}

/** `decideAll` over decisions; a missing decision is a `validation` denial. */
export async function decideSet(
  permissions: readonly Permission[],
  rows: readonly unknown[],
  anyOf: boolean,
  decide: DecideRows,
): Promise<SetDecision> {
  const outcome = await decideAll(
    permissions,
    rows,
    anyOf,
    decide,
    (decision) => decision.outcome === "granted",
  );
  if (outcome.ok) {
    return outcome.result.outcome === "granted"
      ? { ok: true, decision: outcome.result }
      : refused(outcome.result, permissions[0] ?? noPermission(), rows[0]);
  }
  return refused(outcome.result, outcome.permission, outcome.row);
}

function refused(
  decision: Decision | undefined,
  permission: Permission,
  row: unknown,
): SetDecision {
  return {
    ok: false,
    decision:
      decision === undefined || decision.outcome === "granted"
        ? missing()
        : decision,
    permission,
    row,
  };
}

function missing(): Refused {
  return {
    outcome: "denied",
    denials: [{ role: null, reason: "validation" }],
    alternatives: [],
  };
}

function noPermission(): never {
  throw new TypeError("PermDock: protect needs at least one permission");
}
