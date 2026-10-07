import type { Subject } from "../core/subject.ts";

import { isReadonlyArray } from "../core/compact.ts";
import { expiredAt } from "../core/expiry.ts";
import { sameId } from "../core/ids.ts";
import { ownGet } from "../core/paths.ts";
import {
  type Scope,
  resolveScope,
  scopeList,
  subjectMemberships,
  tenantOf,
} from "../core/scopes.ts";
import {
  type Condition,
  type ConditionValue,
  isConditionDate,
  isConditionRef,
  type MemberOfParent,
  type RelatedCondition,
  parentHop,
} from "./ast.ts";
import { resolveConditionRef } from "./refs.ts";

function resolveRef(ref: string, subject: Subject): unknown {
  return resolveConditionRef(ref, subject);
}

function unwrap(value: ConditionValue, subject: Subject): unknown {
  if (isConditionRef(value)) {
    return resolveRef(value.ref, subject);
  }
  if (isConditionDate(value)) {
    return new Date(isoInstant(value.date) ?? Number.NaN);
  }
  if (isReadonlyArray(value)) {
    return value.map((item) => unwrap(item, subject));
  }
  return value;
}

// ISO 8601 date or date-time, including the Postgres text form
// (`2020-01-02 10:00:00+00`). Anything else is never an instant.
const ISO_INSTANT =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}(?::?\d{2})?)?)?$/u;

function isoInstant(value: string): number | undefined {
  const match = ISO_INSTANT.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, day, time, zone] = match;
  let offset = zone ?? (time === undefined ? "" : "Z");
  if (/^[+-]\d{2}$/u.test(offset)) {
    offset = `${offset}:00`;
  } else if (/^[+-]\d{4}$/u.test(offset)) {
    offset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
  }
  const parsed = Date.parse(
    time === undefined ? `${day}` : `${day}T${time}${offset}`,
  );
  return Number.isNaN(parsed) ? undefined : parsed;
}

function instantOf(value: unknown): number | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? undefined : time;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    return isoInstant(value);
  }
  return undefined;
}

// Instants only when one side is a Date (a row value or a date literal);
// otherwise same-type primitives only, so '2' never equals 2 or 'user-2'.
function comparablePair(
  left: unknown,
  right: unknown,
): readonly [string | number | boolean, string | number | boolean] | undefined {
  if (left instanceof Date || right instanceof Date) {
    const a = instantOf(left);
    const b = instantOf(right);
    return a === undefined || b === undefined ? undefined : [a, b];
  }
  const kind = typeof left;
  if (
    kind === typeof right &&
    (kind === "string" || kind === "number" || kind === "boolean")
  ) {
    // SAFETY: kind is typeof both sides and was checked to be string, number or boolean above.
    return [
      left as string | number | boolean,
      right as string | number | boolean,
    ];
  }
  return undefined;
}

function compare(op: string, left: unknown, right: unknown): boolean {
  if (
    left === undefined ||
    left === null ||
    right === undefined ||
    right === null
  ) {
    return false;
  }
  const comparable = comparablePair(left, right);
  if (comparable === undefined) {
    return false;
  }
  const [a, b] = comparable;
  switch (op) {
    case "eq":
      return a === b;
    case "ne":
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
      /* v8 ignore next */
      return false;
  }
}

function contains(left: unknown, right: unknown): boolean {
  if (
    left === undefined ||
    left === null ||
    right === undefined ||
    right === null
  ) {
    return false;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left.includes(right);
  }
  if (Array.isArray(left)) {
    return left.includes(right);
  }
  return false;
}

function inList(left: unknown, right: unknown): boolean {
  if (left === undefined || left === null || !Array.isArray(right)) {
    return false;
  }
  return right.includes(left);
}

function matchesParentHop(
  data: object,
  parents: readonly MemberOfParent[] | undefined,
  on: { readonly resource: string; readonly id: string },
): boolean {
  for (const parent of parents ?? []) {
    const hop = parentHop(parent);
    if (hop.resource !== undefined && hop.resource !== on.resource) {
      continue;
    }
    if (sameId(ownGet(data, hop.field), on.id)) {
      return true;
    }
  }
  return false;
}

function evaluateMemberOf(
  condition: Extract<Condition, { readonly op: "memberOf" }>,
  data: unknown,
  subject: Subject,
  now: number,
  scopes: readonly Scope[],
): boolean {
  if (data === null || typeof data !== "object") {
    return false;
  }
  const rowValue = ownGet(data, condition.field);
  if (rowValue === undefined || rowValue === null) {
    return false;
  }
  const memberships = subjectMemberships(
    subject.principal?.memberships,
    scopes,
  );
  const wanted = new Set(condition.roles);
  const active =
    subject.principal?.tenant === "" ? undefined : subject.principal?.tenant;
  const scope =
    condition.scope === "resource"
      ? undefined
      : resolveScope(scopes, condition.scope);
  if (condition.scope !== "resource" && scope === undefined) {
    return false;
  }
  for (const membership of memberships) {
    if (expiredAt(membership, now)) {
      continue;
    }
    if (wanted.size > 0 && !membership.roles.some((role) => wanted.has(role))) {
      continue;
    }
    if (scope !== undefined) {
      if (membership.scope !== scope || !sameId(membership.id, rowValue)) {
        continue;
      }
      // With an active tenant, only memberships inside it count.
      const tenant = tenantOf(membership, scopes);
      if (active !== undefined && tenant !== undefined && tenant !== active) {
        continue;
      }
      return true;
    }
    if (membership.on === undefined) {
      continue;
    }
    if (
      condition.resource !== undefined &&
      membership.on.resource !== condition.resource
    ) {
      if (matchesParentHop(data, condition.parents, membership.on)) {
        return true;
      }
      continue;
    }
    if (sameId(membership.on.id, rowValue)) {
      return true;
    }
    if (matchesParentHop(data, condition.parents, membership.on)) {
      return true;
    }
  }
  return false;
}

/** Answers a `related` node on one row; without one, `related` never matches. */
export type RelatedResolver = (
  condition: RelatedCondition,
  data: unknown,
) => boolean;

/**
 * Called for each `opaque` node reached. The node evaluates to `false`, so a
 * caller that must not let `not(opaque)` match records the call and fails.
 */
export type OpaqueHook = () => void;

export function evaluateCondition(
  condition: Condition,
  data: unknown,
  subject: Subject,
  now: number = Date.now() / 1000,
  scopes: readonly Scope[] = scopeList(undefined),
  related?: RelatedResolver,
  onOpaque?: OpaqueHook,
): boolean {
  switch (condition.op) {
    case "and":
      return condition.conditions.every((child) =>
        evaluateCondition(child, data, subject, now, scopes, related, onOpaque),
      );
    case "or":
      return condition.conditions.some((child) =>
        evaluateCondition(child, data, subject, now, scopes, related, onOpaque),
      );
    case "not":
      return !evaluateCondition(
        condition.condition,
        data,
        subject,
        now,
        scopes,
        related,
        onOpaque,
      );
    case "isNull": {
      if (data === null || typeof data !== "object") {
        return false;
      }
      const value = ownGet(data, condition.field);
      const isNull = value === null || value === undefined;
      return condition.value ? isNull : !isNull;
    }
    case "in":
    case "notIn": {
      if (data === null || typeof data !== "object") {
        return false;
      }
      const left = ownGet(data, condition.field);
      const right = unwrap(condition.value, subject);
      const matched = inList(left, right);
      return condition.op === "in"
        ? matched
        : !matched && left !== undefined && left !== null;
    }
    case "contains": {
      if (data === null || typeof data !== "object") {
        return false;
      }
      return contains(
        ownGet(data, condition.field),
        unwrap(condition.value, subject),
      );
    }
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (condition.field === "_" && condition.op === "eq") {
        return condition.value === true;
      }
      if (data === null || typeof data !== "object") {
        return false;
      }
      return compare(
        condition.op,
        ownGet(data, condition.field),
        unwrap(condition.value, subject),
      );
    }
    case "memberOf":
      return evaluateMemberOf(condition, data, subject, now, scopes);
    case "related":
      return related?.(condition, data) === true;
    case "sqlFunction":
      return evaluateCondition(
        condition.twin,
        data,
        subject,
        now,
        scopes,
        related,
        onOpaque,
      );
    case "opaque":
      onOpaque?.();
      return false;
    case "liveSession":
      return subject.liveSession === true;
    default: {
      const exhaustive: never = condition;
      /* v8 ignore next */
      return exhaustive;
    }
  }
}
