import type { WhereResult } from '../core/permdock.ts';
import type { Membership, Subject } from '../core/subject.ts';

import { compact } from '../core/compact.ts';
import { PermDockValidationError } from '../core/errors.ts';
import { assertSafeKey } from '../core/paths.ts';
import {
  type Condition,
  type ConditionValue,
  isConditionDate,
  isConditionRef,
} from './ast.ts';

export type MembershipTable = {
  readonly table: string;
  readonly user: string;
  readonly role: string;
  readonly tenant?: string;
  readonly team?: string;
  readonly id?: string;
  readonly expiresAt?: string;
};

export type MembershipsMapping = {
  readonly tenant?: MembershipTable;
  readonly team?: MembershipTable;
  readonly resource?: Readonly<Record<string, MembershipTable>>;
};

export type CompileWhereOptions = {
  readonly subject?: Subject;
  readonly memberships?: MembershipsMapping;
  readonly now?: number;
};

export type CompiledCompare = {
  readonly kind: 'compare';
  readonly op:
    | 'eq'
    | 'ne'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'contains'
    | 'in'
    | 'notIn';
  readonly field: string;
  readonly value: unknown;
};

export type CompiledExists = {
  readonly kind: 'exists';
  readonly table: string;
  readonly user: string;
  readonly userValue: string;
  readonly role: string;
  readonly roles: readonly string[];
  readonly rowColumn: string;
  readonly rowField: string;
  readonly expiresAt?: string;
  readonly tenantColumn?: string;
  readonly tenantValue?: string;
};

export type CompiledWhere =
  | { readonly kind: 'never' }
  | { readonly kind: 'always' }
  | CompiledCompare
  | {
      readonly kind: 'isNull';
      readonly field: string;
      readonly negated: boolean;
    }
  | { readonly kind: 'and' | 'or'; readonly items: readonly CompiledWhere[] }
  | { readonly kind: 'not'; readonly item: CompiledWhere }
  | CompiledExists;

function isExpired(membership: Membership, now: number): boolean {
  return membership.expiresAt !== undefined && membership.expiresAt <= now;
}

function resolveRef(ref: string, subject: Subject | undefined): unknown {
  if (subject === undefined || !ref.startsWith('subject')) {
    return undefined;
  }
  const rest = ref.slice('subject'.length);
  if (rest === '') {
    return subject;
  }
  if (!rest.startsWith('.')) {
    return undefined;
  }
  const path = rest.slice(1);
  if (path === 'id') {
    return subject.principal?.id;
  }
  if (path.startsWith('context.')) {
    const key = path.slice('context.'.length);
    assertSafeKey(key.split('.')[0] ?? key, 'subject path');
    let current: unknown = subject.context;
    for (const segment of key.split('.')) {
      if (
        current === null ||
        typeof current !== 'object' ||
        !Object.hasOwn(current, segment)
      ) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }
  if (subject.principal === null) {
    return undefined;
  }
  let current: unknown = subject.principal;
  for (const segment of path.split('.')) {
    assertSafeKey(segment, 'subject path');
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function unwrap(value: ConditionValue, subject: Subject | undefined): unknown {
  if (isConditionRef(value)) {
    return resolveRef(value.ref, subject);
  }
  if (isConditionDate(value)) {
    return value.date;
  }
  if (Array.isArray(value)) {
    return value.map((item) => unwrap(item, subject));
  }
  return value;
}

function nonPortable(detail: string): PermDockValidationError {
  return new PermDockValidationError({
    code: 'non-portable-condition',
    permission: '',
    resource: '',
    boundary: 'where',
    message: `PermDock: non-portable-condition: ${detail}`,
  });
}

export function asPortableCondition(input: Condition | WhereResult): Condition {
  if ('partial' in input && input.partial) {
    throw nonPortable('closure grant');
  }
  if ('condition' in input && !('op' in input)) {
    return input.condition;
  }
  return input as Condition;
}

function matchingMemberships(
  condition: Extract<Condition, { readonly op: 'memberOf' }>,
  subject: Subject | undefined,
  now: number,
): Membership[] {
  const memberships = subject?.principal?.memberships ?? [];
  const wanted = new Set(condition.roles);
  return memberships.filter((membership) => {
    if (isExpired(membership, now)) {
      return false;
    }
    return membership.roles.some((role) => wanted.has(role));
  });
}

function inList(field: string, values: readonly unknown[]): CompiledWhere {
  const unique = [
    ...new Set(values.filter((value) => value !== null && value !== undefined)),
  ];
  if (unique.length === 0) {
    return { kind: 'never' };
  }
  if (unique.length === 1) {
    return { kind: 'compare', op: 'eq', field, value: unique[0] };
  }
  return { kind: 'compare', op: 'in', field, value: unique };
}

function compileExists(
  condition: Extract<Condition, { readonly op: 'memberOf' }>,
  table: MembershipTable,
  subject: Subject | undefined,
): CompiledWhere {
  const userValue = subject?.principal?.id;
  if (typeof userValue !== 'string' || userValue === '') {
    return { kind: 'never' };
  }
  const rowColumn =
    condition.scope === 'tenant'
      ? table.tenant
      : condition.scope === 'team'
        ? table.team
        : table.id;
  if (rowColumn === undefined) {
    return { kind: 'never' };
  }
  assertSafeKey(table.table, 'membership table');
  assertSafeKey(rowColumn, 'membership column');
  return compact<CompiledExists>({
    kind: 'exists',
    table: table.table,
    user: table.user,
    userValue,
    role: table.role,
    roles: condition.roles,
    rowColumn,
    rowField: condition.field,
    expiresAt: table.expiresAt,
    tenantColumn: condition.scope === 'team' ? table.tenant : undefined,
    tenantValue:
      condition.scope === 'team' ? subject?.principal?.tenant : undefined,
  });
}

function compileMemberOf(
  condition: Extract<Condition, { readonly op: 'memberOf' }>,
  options: CompileWhereOptions,
): CompiledWhere {
  assertSafeKey(condition.field, 'condition field');
  const mapping =
    condition.scope === 'resource'
      ? condition.resource === undefined
        ? undefined
        : options.memberships?.resource?.[condition.resource]
      : options.memberships?.[condition.scope];
  if (mapping !== undefined) {
    return compileExists(condition, mapping, options.subject);
  }
  const now = options.now ?? Date.now() / 1000;
  const matched = matchingMemberships(condition, options.subject, now);
  if (condition.scope === 'tenant') {
    const active = options.subject?.principal?.tenant;
    if (active !== undefined && active !== '') {
      const holds = matched.some((membership) => membership.tenant === active);
      return holds
        ? { kind: 'compare', op: 'eq', field: condition.field, value: active }
        : { kind: 'never' };
    }
    return inList(
      condition.field,
      matched.flatMap((membership) =>
        membership.tenant === undefined ? [] : [membership.tenant],
      ),
    );
  }
  if (condition.scope === 'team') {
    const active = options.subject?.principal?.tenant;
    const teams = matched.flatMap((membership) => {
      if (membership.team === undefined) {
        return [];
      }
      if (
        active !== undefined &&
        membership.tenant !== undefined &&
        membership.tenant !== active
      ) {
        return [];
      }
      return [membership.team];
    });
    return inList(condition.field, teams);
  }
  const onField: CompiledWhere[] = [];
  const ids = matched.flatMap((membership) => {
    if (membership.on === undefined) {
      return [];
    }
    if (
      condition.resource !== undefined &&
      membership.on.resource !== condition.resource
    ) {
      return [];
    }
    return [membership.on.id];
  });
  const fieldPred = inList(condition.field, ids);
  if (fieldPred.kind !== 'never') {
    onField.push(fieldPred);
  }
  const parentIds = matched.flatMap((membership) =>
    membership.on === undefined ? [] : [membership.on.id],
  );
  for (const parent of condition.parents ?? []) {
    assertSafeKey(parent, 'condition field');
    const parentPred = inList(parent, parentIds);
    if (parentPred.kind !== 'never') {
      onField.push(parentPred);
    }
  }
  if (onField.length === 0) {
    return { kind: 'never' };
  }
  return onField.length === 1 ? onField[0]! : { kind: 'or', items: onField };
}

function compileNode(
  condition: Condition,
  options: CompileWhereOptions,
): CompiledWhere {
  switch (condition.op) {
    case 'and': {
      const items = condition.conditions.map((child) =>
        compileNode(child, options),
      );
      if (items.some((item) => item.kind === 'never')) {
        return { kind: 'never' };
      }
      const kept = items.filter((item) => item.kind !== 'always');
      if (kept.length === 0) {
        return { kind: 'always' };
      }
      return kept.length === 1 ? kept[0]! : { kind: 'and', items: kept };
    }
    case 'or': {
      if (condition.conditions.length === 0) {
        return { kind: 'never' };
      }
      const items = condition.conditions.map((child) =>
        compileNode(child, options),
      );
      if (items.some((item) => item.kind === 'always')) {
        return { kind: 'always' };
      }
      const kept = items.filter((item) => item.kind !== 'never');
      if (kept.length === 0) {
        return { kind: 'never' };
      }
      return kept.length === 1 ? kept[0]! : { kind: 'or', items: kept };
    }
    case 'not': {
      const item = compileNode(condition.condition, options);
      if (item.kind === 'never') {
        return { kind: 'always' };
      }
      if (item.kind === 'always') {
        return { kind: 'never' };
      }
      return { kind: 'not', item };
    }
    case 'isNull':
      assertSafeKey(condition.field, 'condition field');
      return {
        kind: 'isNull',
        field: condition.field,
        negated: !condition.value,
      };
    case 'opaque':
      throw nonPortable('opaque SQL');
    case 'memberOf':
      return compileMemberOf(condition, options);
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'contains':
    case 'in':
    case 'notIn': {
      if (condition.field === '_' && condition.op === 'eq') {
        return condition.value === true
          ? { kind: 'always' }
          : { kind: 'never' };
      }
      assertSafeKey(condition.field, 'condition field');
      const value = unwrap(
        'value' in condition ? (condition.value as ConditionValue) : true,
        options.subject,
      );
      if (condition.op === 'in' || condition.op === 'notIn') {
        const list = Array.isArray(value) ? value : [];
        if (list.length === 0) {
          return condition.op === 'in' ? { kind: 'never' } : { kind: 'always' };
        }
        return {
          kind: 'compare',
          op: condition.op,
          field: condition.field,
          value: list,
        };
      }
      return {
        kind: 'compare',
        op: condition.op,
        field: condition.field,
        value,
      };
    }
    default: {
      const exhaustive: never = condition;
      void exhaustive;
      throw nonPortable('unknown condition');
    }
  }
}

export function compileWhere(
  input: Condition | WhereResult,
  options: CompileWhereOptions = {},
): CompiledWhere {
  return compileNode(asPortableCondition(input), options);
}
