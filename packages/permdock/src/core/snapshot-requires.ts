import type { Condition } from "../conditions/ast.ts";
import type {
  ExpandedSnapshot,
  SnapshotGrant,
  SnapshotGrantTerms,
  SnapshotWireTerms,
} from "./snapshot-types.ts";
import type { Membership } from "./subject.ts";

import { canonicalJson } from "./canonical-json.ts";
import { sole } from "./compact.ts";

/**
 * Where the subject holds a required key: `true` globally, else the ids per
 * scope, minus those a deny reaches.
 */
export type KeyHolding = true | ReadonlyMap<string, ReadonlySet<string>>;

type Fields = readonly (readonly [scope: string, field: string])[];

type RequiresTable = NonNullable<ExpandedSnapshot["requires"]>;

function and(
  left: Condition | undefined,
  right: Condition | undefined,
): Condition | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return { op: "and", conditions: [left, right] };
}

/**
 * The row condition of one required key: `undefined` when held globally, else
 * an `in` per partition with ids. The evaluator and the snapshot decoder both
 * place requirements with it.
 */
function placeRequirement(
  fields: Fields,
  held: KeyHolding,
): Condition | undefined {
  if (held === true) {
    return undefined;
  }
  const parts: Condition[] = [];
  for (const [scope, field] of fields) {
    const ids = [...(held.get(scope) ?? [])].toSorted();
    if (ids.length > 0) {
      parts.push({ op: "in", field, value: ids });
    }
  }
  return sole(parts) ?? { op: "or", conditions: parts };
}

/**
 * `placeRequirement` over every key, combined in the order `requires` lists
 * them.
 */
export function placeRequirements(
  keys: readonly string[],
  fields: Fields,
  holdingOf: (key: string) => KeyHolding,
): Condition | undefined {
  let where: Condition | undefined;
  for (const key of keys) {
    where = and(where, placeRequirement(fields, holdingOf(key)));
  }
  return where;
}

/**
 * Per key the grants require, the membership indexes where the subject holds
 * it, or `true` for a global hold.
 */
export function requiresTable(
  grants: readonly SnapshotGrant[],
  memberships: readonly Membership[],
  holding: ((key: string) => KeyHolding) | undefined,
): RequiresTable | undefined {
  const keys = new Set(grants.flatMap((grant) => grant.requires?.keys ?? []));
  if (holding === undefined || keys.size === 0) {
    return undefined;
  }
  const table: Record<string, true | readonly number[]> = {};
  for (const key of [...keys].toSorted()) {
    const held = holding(key);
    table[key] =
      held === true
        ? true
        : memberships.flatMap((membership, at) =>
            membership.scope !== undefined &&
            membership.id !== undefined &&
            held.get(membership.scope)?.has(membership.id) === true
              ? [at]
              : [],
          );
  }
  return table;
}

function holdingFrom(
  entry: true | readonly number[] | undefined,
  memberships: readonly Membership[],
): KeyHolding {
  if (entry === true) {
    return true;
  }
  const held = new Map<string, Set<string>>();
  for (const at of entry ?? []) {
    const membership = memberships[at];
    if (membership?.scope === undefined || membership.id === undefined) {
      continue;
    }
    const ids = held.get(membership.scope) ?? new Set<string>();
    ids.add(membership.id);
    held.set(membership.scope, ids);
  }
  return held;
}

function placedFrom(
  terms: SnapshotGrantTerms,
  table: RequiresTable | undefined,
  memberships: readonly Membership[],
): Condition | undefined {
  const requires = terms.requires;
  return requires === undefined
    ? undefined
    : placeRequirements(requires.keys, requires.fields, (key) =>
        holdingFrom(table?.[key], memberships),
      );
}

/**
 * The terms as the wire writes them: `where` without the requirement the
 * `requires` table places back. A `where` that does not end with exactly that
 * requirement is written whole and marked `placed`.
 */
export function withoutRequirement(
  terms: SnapshotGrantTerms,
  table: RequiresTable | undefined,
  memberships: readonly Membership[],
): SnapshotWireTerms {
  const placed = placedFrom(terms, table, memberships);
  const where = terms.where;
  if (terms.requires === undefined || placed === undefined) {
    return terms;
  }
  const { where: _where, ...rest } = terms;
  const want = canonicalJson(placed);
  if (where !== undefined && canonicalJson(where) === want) {
    return rest;
  }
  if (where?.op === "and" && where.conditions.length === 2) {
    const [base, last] = where.conditions;
    if (base !== undefined && canonicalJson(last) === want) {
      return { ...rest, where: base };
    }
  }
  return { ...terms, placed: true };
}

/**
 * Places requirements back from one snapshot's `requires` table, building each
 * key's holding once per read.
 */
export function requirementPlacer(
  table: RequiresTable | undefined,
  memberships: readonly Membership[],
): (terms: SnapshotWireTerms) => SnapshotGrantTerms {
  const holdings = new Map<string, KeyHolding>();
  const holdingOf = (key: string): KeyHolding => {
    let held = holdings.get(key);
    if (held === undefined) {
      held = holdingFrom(table?.[key], memberships);
      holdings.set(key, held);
    }
    return held;
  };
  return (terms) => {
    if (terms.requires === undefined && terms.placed === undefined) {
      return terms;
    }
    const { placed: wasPlaced, ...rest } = terms;
    const requires = rest.requires;
    if (wasPlaced === true || requires === undefined) {
      return rest;
    }
    const where = and(
      rest.where,
      placeRequirements(requires.keys, requires.fields, holdingOf),
    );
    return where === undefined ? rest : { ...rest, where };
  };
}
