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
  parentHop,
} from './ast.ts';
import { resolveConditionRef } from './refs.ts';

export type MembershipTable = {
  readonly table: string;
  readonly user: string;
  readonly role: string;
  readonly tenant?: string;
  readonly team?: string;
  readonly id?: string;
  /** Column naming the membership's resource, when one table holds several kinds. */
  readonly resource?: string;
  /** Unix seconds, like `Membership.expiresAt`; `null` never expires. */
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
  /** Empty means any role. */
  readonly roles: readonly string[];
  readonly rowColumn: string;
  readonly rowField: string;
  readonly expiresAt?: string;
  /** Unix seconds the `expiresAt` column is compared against. */
  readonly now: number;
  /** A membership row matches when this column is `null` or equals `tenantValue`. */
  readonly tenantColumn?: string;
  readonly tenantValue?: string;
  readonly resourceColumn?: string;
  readonly resourceValue?: string;
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

const NEVER: CompiledWhere = { kind: 'never' };
const ALWAYS: CompiledWhere = { kind: 'always' };

function isExpired(membership: Membership, now: number): boolean {
  return membership.expiresAt !== undefined && membership.expiresAt <= now;
}

function isScalar(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  );
}

/**
 * The SQL-bound value of a condition operand. A ref the subject does not
 * resolve, or resolves to an object, becomes `null`: the in-memory evaluator
 * never matches it, so the compiled form must not either.
 */
function unwrap(value: ConditionValue, subject: Subject | undefined): unknown {
  if (isConditionRef(value)) {
    const resolved = resolveConditionRef(value.ref, subject);
    if (Array.isArray(resolved)) {
      return resolved.filter((item) => isScalar(item));
    }
    return isScalar(resolved) ? resolved : null;
  }
  if (isConditionDate(value)) {
    const date = new Date(value.date);
    return Number.isNaN(date.getTime()) ? null : date;
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

/** A `contains` pattern for `LIKE`: `%`, `_` and the escape itself match literally. */
export function escapeLike(value: string): string {
  return value.replaceAll(/[\\%_]/gu, (char) => `\\${char}`);
}

function allOf(items: readonly CompiledWhere[]): CompiledWhere {
  if (items.some((item) => item.kind === 'never')) {
    return NEVER;
  }
  const kept = items.filter((item) => item.kind !== 'always');
  if (kept.length === 0) {
    return ALWAYS;
  }
  return kept.length === 1 ? kept[0]! : { kind: 'and', items: kept };
}

function anyOf(items: readonly CompiledWhere[]): CompiledWhere {
  if (items.some((item) => item.kind === 'always')) {
    return ALWAYS;
  }
  const kept = items.filter((item) => item.kind !== 'never');
  if (kept.length === 0) {
    return NEVER;
  }
  return kept.length === 1 ? kept[0]! : { kind: 'or', items: kept };
}

/**
 * Negation normal form. In memory a comparison against a NULL field is
 * false, so its negation is true; SQL's `NOT (NULL)` stays NULL. Every
 * negated comparison therefore also admits the NULL field explicitly, and
 * `not` only ever wraps a comparison or an `exists`.
 */
function negate(node: CompiledWhere): CompiledWhere {
  switch (node.kind) {
    case 'never':
      return ALWAYS;
    case 'always':
      return NEVER;
    case 'and':
      return anyOf(node.items.map((item) => negate(item)));
    case 'or':
      return allOf(node.items.map((item) => negate(item)));
    case 'not':
      return node.item;
    case 'isNull':
      return { ...node, negated: !node.negated };
    case 'compare':
      return anyOf([
        { kind: 'not', item: node },
        { kind: 'isNull', field: node.field, negated: false },
      ]);
    case 'exists':
      return { kind: 'not', item: node };
    default: {
      const exhaustive: never = node;
      throw nonPortable(`unknown compiled node '${String(exhaustive)}'`);
    }
  }
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
    if (wanted.size === 0) {
      return true;
    }
    return membership.roles.some((role) => wanted.has(role));
  });
}

function inList(field: string, values: readonly unknown[]): CompiledWhere {
  const unique = [
    ...new Set(values.filter((value) => value !== null && value !== undefined)),
  ];
  if (unique.length === 0) {
    return NEVER;
  }
  if (unique.length === 1) {
    return { kind: 'compare', op: 'eq', field, value: unique[0] };
  }
  return { kind: 'compare', op: 'in', field, value: unique };
}

function activeTenant(subject: Subject | undefined): string | undefined {
  const tenant = subject?.principal?.tenant;
  return tenant === undefined || tenant === '' ? undefined : tenant;
}

function existsOn(
  table: MembershipTable,
  subject: Subject,
  roles: readonly string[],
  rowColumn: string,
  rowField: string,
  scoped: {
    readonly now: number;
    readonly tenant: boolean;
    readonly resource: string | undefined;
  },
): CompiledExists {
  assertSafeKey(table.table, 'membership table');
  assertSafeKey(rowColumn, 'membership column');
  assertSafeKey(rowField, 'condition field');
  const tenantValue = scoped.tenant ? activeTenant(subject) : undefined;
  return compact<CompiledExists>({
    kind: 'exists',
    table: table.table,
    user: table.user,
    userValue: subject.principal?.id ?? '',
    role: table.role,
    roles,
    rowColumn,
    rowField,
    expiresAt: table.expiresAt,
    now: scoped.now,
    tenantColumn: tenantValue === undefined ? undefined : table.tenant,
    tenantValue: table.tenant === undefined ? undefined : tenantValue,
    resourceColumn: scoped.resource === undefined ? undefined : table.resource,
    resourceValue: table.resource === undefined ? undefined : scoped.resource,
  });
}

function compileExists(
  condition: Extract<Condition, { readonly op: 'memberOf' }>,
  table: MembershipTable,
  subject: Subject | undefined,
  now: number,
  mappings: MembershipsMapping | undefined,
): CompiledWhere {
  const userValue = subject?.principal?.id;
  if (
    subject === undefined ||
    typeof userValue !== 'string' ||
    userValue === ''
  ) {
    return NEVER;
  }
  const rowColumn =
    condition.scope === 'tenant'
      ? table.tenant
      : condition.scope === 'team'
        ? table.team
        : table.id;
  if (rowColumn === undefined) {
    return NEVER;
  }
  const own = existsOn(
    table,
    subject,
    condition.roles,
    rowColumn,
    condition.field,
    {
      now,
      tenant: condition.scope !== 'resource',
      resource: condition.scope === 'resource' ? condition.resource : undefined,
    },
  );
  if (condition.scope !== 'resource') {
    return own;
  }
  // As `evaluateCondition`: a keyed hop needs the resource column to key on,
  // a bare field matches a membership on any resource.
  return anyOf([
    own,
    ...(condition.parents ?? []).map((parent) => {
      const hop = parentHop(parent);
      if (hop.resource === undefined) {
        return existsOn(table, subject, condition.roles, rowColumn, hop.field, {
          now,
          tenant: false,
          resource: undefined,
        });
      }
      const hopTable = mappings?.resource?.[hop.resource];
      if (hopTable?.id === undefined) {
        return NEVER;
      }
      return existsOn(
        hopTable,
        subject,
        condition.roles,
        hopTable.id,
        hop.field,
        {
          now,
          tenant: false,
          resource: hop.resource,
        },
      );
    }),
  ]);
}

function compileMemberOf(
  condition: Extract<Condition, { readonly op: 'memberOf' }>,
  options: CompileWhereOptions,
): CompiledWhere {
  assertSafeKey(condition.field, 'condition field');
  const now = options.now ?? Date.now() / 1000;
  const mapping =
    condition.scope === 'resource'
      ? condition.resource === undefined
        ? undefined
        : options.memberships?.resource?.[condition.resource]
      : options.memberships?.[condition.scope];
  if (mapping !== undefined) {
    // Integer seconds bind to a bigint column; rounding up expires a
    // membership up to a second early, never late.
    return compileExists(
      condition,
      mapping,
      options.subject,
      Math.ceil(now),
      options.memberships,
    );
  }
  const matched = matchingMemberships(condition, options.subject, now);
  const active = activeTenant(options.subject);
  if (condition.scope === 'tenant') {
    return inList(
      condition.field,
      matched.flatMap((membership) =>
        membership.tenant === undefined ||
        (active !== undefined && membership.tenant !== active)
          ? []
          : [membership.tenant],
      ),
    );
  }
  if (condition.scope === 'team') {
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
  return anyOf([
    inList(condition.field, ids),
    ...(condition.parents ?? []).map((parent) => {
      const hop = parentHop(parent);
      assertSafeKey(hop.field, 'condition field');
      return inList(
        hop.field,
        matched.flatMap((membership) =>
          membership.on === undefined ||
          (hop.resource !== undefined &&
            membership.on.resource !== hop.resource)
            ? []
            : [membership.on.id],
        ),
      );
    }),
  ]);
}

function compileCompare(
  condition: Extract<
    Condition,
    {
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
    }
  >,
  options: CompileWhereOptions,
): CompiledWhere {
  if (condition.field === '_' && condition.op === 'eq') {
    return condition.value === true ? ALWAYS : NEVER;
  }
  assertSafeKey(condition.field, 'condition field');
  const value = unwrap(condition.value as ConditionValue, options.subject);
  if (condition.op === 'in' || condition.op === 'notIn') {
    const list = Array.isArray(value)
      ? [
          ...new Set(
            value.filter((item) => item !== null && item !== undefined),
          ),
        ]
      : [];
    if (list.length === 0) {
      // `notIn` of nothing still needs a value: a NULL field never matches.
      return condition.op === 'in'
        ? NEVER
        : { kind: 'isNull', field: condition.field, negated: true };
    }
    return {
      kind: 'compare',
      op: condition.op,
      field: condition.field,
      value: list,
    };
  }
  if (value === null || value === undefined) {
    return NEVER;
  }
  return { kind: 'compare', op: condition.op, field: condition.field, value };
}

function compileNode(
  condition: Condition,
  options: CompileWhereOptions,
): CompiledWhere {
  switch (condition.op) {
    case 'and':
      return allOf(
        condition.conditions.map((child) => compileNode(child, options)),
      );
    case 'or':
      return anyOf(
        condition.conditions.map((child) => compileNode(child, options)),
      );
    case 'not':
      return negate(compileNode(condition.condition, options));
    case 'isNull':
      assertSafeKey(condition.field, 'condition field');
      return {
        kind: 'isNull',
        field: condition.field,
        negated: !condition.value,
      };
    case 'opaque':
      throw nonPortable('opaque SQL');
    case 'sqlFunction':
      return compileNode(condition.twin, options);
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
    case 'notIn':
      return compileCompare(condition, options);
    default: {
      const exhaustive: never = condition;
      void exhaustive;
      throw nonPortable('unknown condition');
    }
  }
}

/** The subject `permdock.where()` was built for, when the input carries one. */
function whereSubject(input: Condition | WhereResult): Subject | undefined {
  return 'partial' in input ? input.subject : undefined;
}

export function compileWhere(
  input: Condition | WhereResult,
  options: CompileWhereOptions = {},
): CompiledWhere {
  const subject = options.subject ?? whereSubject(input);
  return compileNode(
    asPortableCondition(input),
    compact({ ...options, subject }),
  );
}
