import type { WhereResult } from '../core/permdock.ts';
import type { ResourceNode } from '../core/permissions.ts';
import type { Membership, Subject } from '../core/subject.ts';

import { compact, isReadonlyArray, sole } from '../core/compact.ts';
import { PermDockValidationError } from '../core/errors.ts';
import { assertSafeKey } from '../core/paths.ts';
import {
  type Scope,
  resolveScope,
  rootScope,
  scopeChain,
  scopeList,
  subjectMemberships,
  tenantOf,
} from '../core/scopes.ts';
import {
  type Condition,
  type ConditionValue,
  type RelatedCondition,
  isConditionDate,
  isConditionRef,
  parentHop,
} from './ast.ts';
import {
  type GraphSql,
  type RelationsMapping,
  relatedSql,
} from './graph-sql.ts';
import { resolveConditionRef } from './refs.ts';

export type MembershipTable = {
  readonly table: string;
  readonly user: string;
  readonly role: string;
  /** Per scope name, the column holding that scope's id (the row's own scope and its ancestors). */
  readonly columns?: Readonly<Record<string, string>>;
  /** Column of the first scope's id; shorthand for `columns[<first scope>]`. */
  readonly tenant?: string;
  /** Column of the second scope's id; shorthand for `columns[<second scope>]`. */
  readonly team?: string;
  readonly id?: string;
  /** Column naming the membership's resource, when one table holds several kinds. */
  readonly resource?: string;
  /** Column holding the membership kind (`Membership.via`); roles with `for` need it. */
  readonly via?: string;
  /** Unix seconds, like `Membership.expiresAt`; `null` never expires. */
  readonly expiresAt?: string;
};

export type MembershipsMapping = {
  /** The membership table of each named scope. */
  readonly scopes?: Readonly<Record<string, MembershipTable>>;
  /** The first scope's table; shorthand for `scopes[<first scope>]`. */
  readonly tenant?: MembershipTable;
  /** The second scope's table; shorthand for `scopes[<second scope>]`. */
  readonly team?: MembershipTable;
  readonly resource?: Readonly<Record<string, MembershipTable>>;
};

export type CompileWhereOptions = {
  readonly subject?: Subject;
  readonly memberships?: MembershipsMapping;
  readonly now?: number;
  /** The policy's scopes; `where()` results carry them. Defaults to the implicit `tenant` / `team` pair. */
  readonly scopes?: readonly Scope[];
  /** Where the relation graph lives; without it a `related` node is refused. */
  readonly relations?: RelationsMapping;
  /** The policy's resource graph; `where()` results carry it. */
  readonly resources?: ReadonlyMap<string, ResourceNode>;
};

/** The membership table mapped for scope `name`, through the `tenant` / `team` shorthands. */
export function scopeMembershipTable(
  mapping: MembershipsMapping | undefined,
  scopes: readonly Scope[],
  name: string,
): MembershipTable | undefined {
  const table = mapping?.scopes?.[name];
  if (table !== undefined) {
    return table;
  }
  if (name === scopes[0]?.name) {
    return mapping?.tenant;
  }
  if (name === scopes[1]?.name) {
    return mapping?.team;
  }
  return undefined;
}

/** The column of `table` holding scope `name`'s id, through the `tenant` / `team` shorthands. */
export function scopeColumn(
  table: MembershipTable,
  scopes: readonly Scope[],
  name: string,
): string | undefined {
  const column = table.columns?.[name];
  if (column !== undefined) {
    return column;
  }
  if (name === scopes[0]?.name) {
    return table.tenant;
  }
  if (name === scopes[1]?.name) {
    return table.team;
  }
  return undefined;
}

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
  | CompiledExists
  | CompiledSql;

/** A Postgres boolean over the row that is never NULL: a `related` node's subquery. */
export type CompiledSql = {
  readonly kind: 'sql';
  readonly parts: GraphSql;
  /** What a `{ subject: true }` part binds. */
  readonly subject: string;
};

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
  if (isReadonlyArray(value)) {
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

function asPortableCondition(input: Condition | WhereResult): Condition {
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
  return sole(kept) ?? { kind: 'and', items: kept };
}

function anyOf(items: readonly CompiledWhere[]): CompiledWhere {
  if (items.some((item) => item.kind === 'always')) {
    return ALWAYS;
  }
  const kept = items.filter((item) => item.kind !== 'never');
  if (kept.length === 0) {
    return NEVER;
  }
  return sole(kept) ?? { kind: 'or', items: kept };
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
    case 'sql':
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
  scopes: readonly Scope[],
): Membership[] {
  const memberships = subjectMemberships(
    subject?.principal?.memberships,
    scopes,
  );
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
    /** The column holding the first scope's id, when the active tenant narrows the membership. */
    readonly tenantColumn: string | undefined;
    readonly resource: string | undefined;
  },
): CompiledExists {
  assertSafeKey(table.table, 'membership table');
  assertSafeKey(rowColumn, 'membership column');
  assertSafeKey(rowField, 'condition field');
  const tenantValue =
    scoped.tenantColumn === undefined ? undefined : activeTenant(subject);
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
    tenantColumn: tenantValue === undefined ? undefined : scoped.tenantColumn,
    tenantValue,
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
  scopes: readonly Scope[],
): CompiledWhere {
  const userValue = subject?.principal?.id;
  if (
    subject === undefined ||
    typeof userValue !== 'string' ||
    userValue === ''
  ) {
    return NEVER;
  }
  const scope =
    condition.scope === 'resource'
      ? undefined
      : resolveScope(scopes, condition.scope);
  const rowColumn =
    scope === undefined ? table.id : scopeColumn(table, scopes, scope);
  if (rowColumn === undefined) {
    return NEVER;
  }
  const root = rootScope(scopes);
  const own = existsOn(
    table,
    subject,
    condition.roles,
    rowColumn,
    condition.field,
    {
      now,
      tenantColumn:
        scope !== undefined &&
        root !== undefined &&
        scopeChain(scopes, scope).includes(root)
          ? scopeColumn(table, scopes, root)
          : undefined,
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
          tenantColumn: undefined,
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
          tenantColumn: undefined,
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
  const scopes = options.scopes ?? scopeList(undefined);
  const scope =
    condition.scope === 'resource'
      ? undefined
      : resolveScope(scopes, condition.scope);
  if (condition.scope !== 'resource' && scope === undefined) {
    return NEVER;
  }
  const mapping =
    scope === undefined
      ? condition.resource === undefined
        ? undefined
        : options.memberships?.resource?.[condition.resource]
      : scopeMembershipTable(options.memberships, scopes, scope);
  if (mapping !== undefined) {
    // Integer seconds bind to a bigint column; rounding up expires a
    // membership up to a second early, never late.
    return compileExists(
      condition,
      mapping,
      options.subject,
      Math.ceil(now),
      options.memberships,
      scopes,
    );
  }
  const matched = matchingMemberships(condition, options.subject, now, scopes);
  const active = activeTenant(options.subject);
  if (scope !== undefined) {
    return inList(
      condition.field,
      matched.flatMap((membership) => {
        if (membership.scope !== scope || membership.id === undefined) {
          return [];
        }
        const tenant = tenantOf(membership, scopes);
        return active !== undefined && tenant !== undefined && tenant !== active
          ? []
          : [membership.id];
      }),
    );
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

function compileRelated(
  condition: RelatedCondition,
  options: CompileWhereOptions,
): CompiledWhere {
  if (options.relations === undefined || options.resources === undefined) {
    throw nonPortable(
      'related (the relation graph): pass `relations` so it compiles to a subquery, or resolve it to ids first (permdock/prisma resolveRelated)',
    );
  }
  assertSafeKey(condition.field, 'condition field');
  const principal = options.subject?.principal?.id;
  if (
    condition.ids === undefined &&
    (principal === undefined || principal === '')
  ) {
    return NEVER;
  }
  return {
    kind: 'sql',
    parts: relatedSql(condition, {
      ...options.relations,
      resources: options.resources,
    }),
    subject: principal ?? '',
  };
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
    case 'related':
      return compileRelated(condition, options);
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

function whereScopes(
  input: Condition | WhereResult,
): readonly Scope[] | undefined {
  return 'partial' in input ? input.scopes : undefined;
}

function whereResources(
  input: Condition | WhereResult,
): ReadonlyMap<string, ResourceNode> | undefined {
  return 'partial' in input ? input.resources : undefined;
}

export function compileWhere(
  input: Condition | WhereResult,
  options: CompileWhereOptions = {},
): CompiledWhere {
  const subject = options.subject ?? whereSubject(input);
  const scopes = options.scopes ?? whereScopes(input);
  const resources = options.resources ?? whereResources(input);
  return compileNode(
    asPortableCondition(input),
    compact({ ...options, subject, scopes, resources }),
  );
}
