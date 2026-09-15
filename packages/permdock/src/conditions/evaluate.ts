import type { Membership, Subject } from '../core/subject.ts';

import { ownGet } from '../core/paths.ts';
import {
  type Condition,
  type ConditionValue,
  isConditionDate,
  isConditionRef,
} from './ast.ts';
import { resolveConditionRef } from './refs.ts';

function isExpired(membership: Membership, now: number): boolean {
  return membership.expiresAt !== undefined && membership.expiresAt <= now;
}

function resolveRef(ref: string, subject: Subject): unknown {
  return resolveConditionRef(ref, subject);
}

function unwrap(value: ConditionValue, subject: Subject): unknown {
  if (isConditionRef(value)) {
    return resolveRef(value.ref, subject);
  }
  if (isConditionDate(value)) {
    return Date.parse(value.date);
  }
  if (Array.isArray(value)) {
    return value.map((item) => unwrap(item, subject));
  }
  return value;
}

function toInstant(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? undefined : time;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
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
  const leftInstant = toInstant(left);
  const rightInstant = toInstant(right);
  const comparable =
    leftInstant !== undefined && rightInstant !== undefined
      ? ([leftInstant, rightInstant] as const)
      : typeof left === typeof right
        ? ([left, right] as const)
        : undefined;
  if (comparable === undefined) {
    return false;
  }
  const [a, b] = comparable;
  switch (op) {
    case 'eq':
      return a === b;
    case 'ne':
      return a !== b;
    case 'gt':
      return a > b;
    case 'gte':
      return a >= b;
    case 'lt':
      return a < b;
    case 'lte':
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
  if (typeof left === 'string' && typeof right === 'string') {
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
  parents: readonly string[] | undefined,
  membershipId: string,
): boolean {
  if (parents === undefined) {
    return false;
  }
  for (const parentField of parents) {
    if (ownGet(data, parentField) === membershipId) {
      return true;
    }
  }
  return false;
}

function evaluateMemberOf(
  condition: Extract<Condition, { readonly op: 'memberOf' }>,
  data: unknown,
  subject: Subject,
  now: number,
): boolean {
  if (data === null || typeof data !== 'object') {
    return false;
  }
  const rowValue = ownGet(data, condition.field);
  if (rowValue === undefined || rowValue === null) {
    return false;
  }
  const memberships = subject.principal?.memberships ?? [];
  const wanted = new Set(condition.roles);
  for (const membership of memberships) {
    if (isExpired(membership, now)) {
      continue;
    }
    if (wanted.size > 0 && !membership.roles.some((role) => wanted.has(role))) {
      continue;
    }
    if (condition.scope === 'tenant') {
      if (membership.tenant === rowValue) {
        return true;
      }
      continue;
    }
    if (condition.scope === 'team') {
      if (membership.team !== rowValue) {
        continue;
      }
      if (
        membership.tenant !== undefined &&
        subject.principal?.tenant !== undefined
      ) {
        return membership.tenant === subject.principal.tenant;
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
      if (matchesParentHop(data, condition.parents, membership.on.id)) {
        return true;
      }
      continue;
    }
    if (membership.on.id === rowValue) {
      return true;
    }
    if (matchesParentHop(data, condition.parents, membership.on.id)) {
      return true;
    }
  }
  return false;
}

export function evaluateCondition(
  condition: Condition,
  data: unknown,
  subject: Subject,
  now: number = Date.now() / 1000,
): boolean {
  switch (condition.op) {
    case 'and':
      return condition.conditions.every((child) =>
        evaluateCondition(child, data, subject, now),
      );
    case 'or':
      return condition.conditions.some((child) =>
        evaluateCondition(child, data, subject, now),
      );
    case 'not':
      return !evaluateCondition(condition.condition, data, subject, now);
    case 'isNull': {
      if (data === null || typeof data !== 'object') {
        return false;
      }
      const value = ownGet(data, condition.field);
      const isNull = value === null || value === undefined;
      return condition.value ? isNull : !isNull;
    }
    case 'in':
    case 'notIn': {
      if (data === null || typeof data !== 'object') {
        return false;
      }
      const left = ownGet(data, condition.field);
      const right = unwrap(condition.value as ConditionValue, subject);
      const matched = inList(left, right);
      return condition.op === 'in'
        ? matched
        : !matched && left !== undefined && left !== null;
    }
    case 'contains': {
      if (data === null || typeof data !== 'object') {
        return false;
      }
      return contains(
        ownGet(data, condition.field),
        unwrap(condition.value, subject),
      );
    }
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (data === null || typeof data !== 'object') {
        return false;
      }
      return compare(
        condition.op,
        ownGet(data, condition.field),
        unwrap(condition.value, subject),
      );
    }
    case 'memberOf':
      return evaluateMemberOf(condition, data, subject, now);
    case 'sqlFunction':
      return evaluateCondition(condition.twin, data, subject, now);
    case 'opaque':
      return false;
    default: {
      const exhaustive: never = condition;
      /* v8 ignore next */
      return exhaustive;
    }
  }
}
