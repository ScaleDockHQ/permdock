import type { MemberEntry, MembershipSource } from '../core/interfaces.ts';
import type { Membership } from '../core/subject.ts';
import type { SupabaseActiveRow, SupabaseSuspension } from './types.ts';

import { compact } from '../core/compact.ts';

/**
 * Runs one parameterised statement: `pg`'s `client.query` (which resolves
 * `{ rows }`) and `postgres`'s `sql.unsafe` (which resolves the rows) both fit.
 */
export type SqlQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<
  | readonly Record<string, unknown>[]
  | { readonly rows: readonly Record<string, unknown>[] }
>;

type Common = {
  readonly table: string;
  /** Runs the lookups; without it the source only describes SQL (for `permdock supabase hook generate`). */
  readonly query?: SqlQuery;
  /** Drop suspended users and memberships under suspended instances, like `rls.suspension`. */
  readonly suspension?: SupabaseSuspension;
};

export type MembershipTableOptions = Common & {
  /** Column names; `user`, `scope`, `id` and `role` default to `user_id`, `scope`, `scope_id`, `role`. */
  readonly columns?: {
    readonly user?: string;
    readonly scope?: string;
    readonly id?: string;
    /** A `jsonb` column of ancestor ids keyed by scope name. */
    readonly within?: string;
    readonly role?: string;
    readonly via?: string;
    readonly expiresAt?: string;
    /** The principal id that wrote the membership (`grantedBy`). */
    readonly grantedBy?: string;
    /** Free-text justification recorded on the membership (`reason`). */
    readonly reason?: string;
    /** A subgroup column filling `member.group`. */
    readonly group?: string;
    /** A text column; the value `idp` marks the row as owned by the identity provider. */
    readonly managedBy?: string;
    /** A `text[]` column of seats. */
    readonly seats?: string;
  };
};

export type MembershipJunctionOptions = Common & {
  /** The declared scope every row is a membership of. */
  readonly scope: string;
  /** Default `user_id`. */
  readonly user?: string;
  /** The column holding the scope instance id. Default `<scope>_id`. */
  readonly id?: string;
  /** Ancestor id columns keyed by scope name. */
  readonly within?: Readonly<Record<string, string>>;
  /** A role column, or fixed roles every row holds (a contact table with no role column). */
  readonly roles: string | readonly string[];
  /** The membership kind every row has (`contact`, `staff`, `partner`). */
  readonly via?: string;
  readonly expiresAt?: string;
  /** The principal id that wrote the membership (`grantedBy`). */
  readonly grantedBy?: string;
  /** Free-text justification recorded on the membership (`reason`). */
  readonly reason?: string;
  /** A subgroup filling `member.group`: a fixed name every row has, or a column. */
  readonly group?: string | { readonly column: string };
  /** `idp` when the identity provider owns every row, or a text column holding `idp` per row. */
  readonly managedBy?: 'idp' | { readonly column: string };
  /** A `text[]` column of seats. */
  readonly seats?: string;
};

/** What `permdock supabase hook generate` compiles; the same SQL the source runs. */
export type MembershipSql = {
  readonly table: string;
  /** Columns of the table that decide a membership; triggers bump the authorization version on them. */
  readonly user: string;
  /** The `select` of claim rows for one user (`$1`), with every filter applied. */
  select(user: string): string;
  /** The `select` of member rows for one scope instance (`$1` scope, `$2` id). */
  list(): string;
  /** A text column holding `idp` for rows the identity provider owns; `''` when every row is owned. */
  readonly managed?: string;
  /** Other tables the `select` reads (suspension tables). */
  readonly reads: readonly string[];
  /** For a single-scope source: its scope and the scopes whose ids each row carries. */
  readonly scope?: string;
  readonly holds?: readonly string[];
};

export type SqlMembershipSource = MembershipSource & {
  readonly sql: MembershipSql;
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function ident(name: string): string {
  if (!IDENT.test(name)) {
    throw new TypeError(`PermDock: unsafe SQL identifier '${name}'`);
  }
  return `"${name}"`;
}

function qualified(name: string): string {
  return (name.includes('.') ? name : `public.${name}`)
    .split('.')
    .map(ident)
    .join('.');
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function col(name: string): string {
  return `m.${ident(name)}`;
}

function activeRow(row: SupabaseActiveRow, id: string): string {
  const parts = [`s.${ident(row.id)}::text = (${id})::text`];
  if (row.disabledAt !== undefined) {
    parts.push(`s.${ident(row.disabledAt)} is null`);
  }
  if (row.status !== undefined) {
    const values = row.active ?? [];
    if (values.length === 0) {
      throw new TypeError(
        'PermDock: a suspension status column needs its active values',
      );
    }
    parts.push(
      `s.${ident(row.status)}::text = any(array[${values.map(literal).join(', ')}]::text[])`,
    );
  }
  if (row.disabledAt === undefined && row.status === undefined) {
    throw new TypeError(
      'PermDock: a suspension table needs disabledAt or status',
    );
  }
  return `exists (select 1 from ${qualified(row.table)} s where ${parts.join(' and ')})`;
}

type Shape = {
  readonly table: string;
  readonly user: string;
  readonly scope: string;
  readonly id: string;
  readonly within: string;
  readonly roles: string;
  readonly via: string;
  readonly expiresAt: string | undefined;
  readonly grantedBy: string;
  readonly reason: string;
  readonly memberGroup: string;
  readonly managed: string;
  readonly managedColumn: string | undefined;
  readonly seats: string;
  /** SQL for the id the row holds for scope `name`, or `null` when it holds none. */
  readonly idOf: (name: string) => string | undefined;
  readonly groupBy: readonly string[];
  readonly suspension: SupabaseSuspension | undefined;
};

function filters(shape: Shape, owner: string): string[] {
  const lines = [owner];
  if (shape.expiresAt !== undefined) {
    const expires = col(shape.expiresAt);
    lines.push(`(${expires} is null or ${expires} > now())`);
  }
  const users = shape.suspension?.users;
  if (users !== undefined) {
    lines.push(activeRow(users, col(shape.user)));
  }
  for (const [name, row] of Object.entries(shape.suspension?.scopes ?? {})) {
    const id = shape.idOf(name);
    if (id !== undefined) {
      lines.push(`(${id} is null or ${activeRow(row, id)})`);
    }
  }
  return lines;
}

function selectOf(
  shape: Shape,
  where: readonly string[],
  user: boolean,
): string {
  const fields = [
    ...(user ? [`${col(shape.user)}::text as user_id`] : []),
    `${shape.scope} as scope`,
    `${shape.id} as id`,
    `${shape.within} as within`,
    `${shape.roles} as roles`,
    `${shape.via} as via`,
    `${shape.expiresAt === undefined ? 'null::bigint' : `floor(extract(epoch from ${col(shape.expiresAt)}))::bigint`} as expires_at`,
    `${shape.grantedBy} as granted_by`,
    `${shape.reason} as reason`,
    `${shape.memberGroup} as member_group`,
    `${shape.managed} as managed_by`,
    `${shape.seats} as seats`,
  ];
  const group = [...(user ? [col(shape.user)] : []), ...shape.groupBy];
  return `select ${fields.join(', ')}
from ${qualified(shape.table)} m
where ${where.join('\n  and ')}
group by ${group.join(', ')}`;
}

function sqlOf(shape: Shape): MembershipSql {
  const suspension = shape.suspension;
  return compact<MembershipSql>({
    table: shape.table,
    user: shape.user,
    reads: [
      ...new Set(
        [suspension?.users, ...Object.values(suspension?.scopes ?? {})].flatMap(
          (row) => (row === undefined ? [] : [row.table]),
        ),
      ),
    ],
    managed: shape.managedColumn,
    select: (user: string) =>
      selectOf(
        shape,
        filters(shape, `${col(shape.user)}::text = ${user}`),
        false,
      ),
    list: () =>
      selectOf(
        shape,
        filters(shape, `${shape.scope} = $1::text and ${shape.id} = $2::text`),
        true,
      ),
  });
}

function rowsOf(
  result: Awaited<ReturnType<SqlQuery>>,
): readonly Record<string, unknown>[] {
  return Array.isArray(result)
    ? result
    : (result as { readonly rows: readonly Record<string, unknown>[] }).rows;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === 'string' && item !== '',
      )
    : [];
}

function membershipOf(row: Record<string, unknown>): Membership | undefined {
  const roles = strings(row.roles);
  if (typeof row.scope !== 'string' || typeof row.id !== 'string') {
    return undefined;
  }
  if (roles.length === 0) {
    return undefined;
  }
  const within =
    row.within !== null &&
    typeof row.within === 'object' &&
    !Array.isArray(row.within)
      ? Object.fromEntries(
          Object.entries(row.within as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : undefined;
  const expires =
    typeof row.expires_at === 'number'
      ? row.expires_at
      : typeof row.expires_at === 'string' && row.expires_at !== ''
        ? Number(row.expires_at)
        : undefined;
  const seats = strings(row.seats);
  return compact<Membership>({
    scope: row.scope,
    id: row.id,
    within:
      within === undefined || Object.keys(within).length === 0
        ? undefined
        : within,
    roles: [...roles].toSorted(),
    via: typeof row.via === 'string' ? row.via : undefined,
    expiresAt: Number.isFinite(expires) ? expires : undefined,
    grantedBy:
      typeof row.granted_by === 'string' && row.granted_by !== ''
        ? row.granted_by
        : undefined,
    reason:
      typeof row.reason === 'string' && row.reason !== ''
        ? row.reason
        : undefined,
    member:
      typeof row.member_group === 'string' && row.member_group !== ''
        ? { group: row.member_group }
        : undefined,
    managedBy: row.managed_by === 'idp' ? 'idp' : undefined,
    entitlements: seats.length === 0 ? undefined : seats,
  });
}

function sourceOf(
  sql: MembershipSql,
  query: SqlQuery | undefined,
): SqlMembershipSource {
  const run = async (
    text: string,
    values: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]> => {
    if (query === undefined) {
      throw new TypeError(
        `PermDock: the ${sql.table} membership source needs query to resolve memberships`,
      );
    }
    return rowsOf(await query(text, values));
  };
  return {
    sql,
    async membershipsFor(principal) {
      const rows = await run(sql.select('$1'), [principal.id]);
      return rows.flatMap((row) => {
        const membership = membershipOf(row);
        return membership === undefined ? [] : [membership];
      });
    },
    async list(scope) {
      const rows = await run(sql.list(), [scope.scope, scope.id]);
      return rows.flatMap((row): MemberEntry[] => {
        const membership = membershipOf(row);
        return membership === undefined || typeof row.user_id !== 'string'
          ? []
          : [{ principal: { id: row.user_id }, membership }];
      });
    },
  };
}

/**
 * Memberships from one table holding every scope: a row per user, scope,
 * instance and role (`user_id, scope, scope_id, role`), with optional
 * `within`, `via`, expiry, owner and seat columns. Rows of the same instance
 * merge into one membership.
 */
export function fromTable(
  options: MembershipTableOptions,
): SqlMembershipSource {
  const c = options.columns ?? {};
  const scope = `${col(c.scope ?? 'scope')}::text`;
  const id = `${col(c.id ?? 'scope_id')}::text`;
  const within = c.within === undefined ? 'null::jsonb' : col(c.within);
  const optional = (name: string | undefined, cast: string): string =>
    name === undefined ? `null::${cast}` : `${col(name)}::${cast}`;
  const shape: Shape = {
    table: options.table,
    user: c.user ?? 'user_id',
    scope,
    id,
    within,
    roles: `jsonb_agg(distinct ${col(c.role ?? 'role')}::text order by ${col(c.role ?? 'role')}::text)`,
    via: optional(c.via, 'text'),
    expiresAt: c.expiresAt,
    grantedBy: optional(c.grantedBy, 'text'),
    reason: optional(c.reason, 'text'),
    memberGroup: optional(c.group, 'text'),
    managed: optional(c.managedBy, 'text'),
    managedColumn: c.managedBy,
    seats: c.seats === undefined ? 'null::jsonb' : `to_jsonb(${col(c.seats)})`,
    idOf: (name) =>
      `coalesce(case when ${scope} = ${literal(name)} then ${id} end${c.within === undefined ? '' : `, ${within} ->> ${literal(name)}`})`,
    groupBy: [
      scope,
      id,
      ...(c.within === undefined ? [] : [within]),
      ...[
        c.via,
        c.expiresAt,
        c.grantedBy,
        c.reason,
        c.group,
        c.managedBy,
        c.seats,
      ]
        .filter((name): name is string => name !== undefined)
        .map(col),
    ],
    suspension: options.suspension,
  };
  return sourceOf(sqlOf(shape), options.query);
}

/**
 * Memberships from a table of one scope (`customer_contacts`): every row is a
 * membership of `scope`, with roles from a column or fixed (`['contact']`), a
 * fixed `via`, and ancestor ids from `within` columns.
 */
export function fromJunction(
  options: MembershipJunctionOptions,
): SqlMembershipSource {
  if (!/^[a-z][a-z0-9_]*$/u.test(options.scope)) {
    throw new TypeError(`PermDock: unsafe scope name '${options.scope}'`);
  }
  const idColumn = options.id ?? `${options.scope}_id`;
  const withinEntries = Object.entries(options.within ?? {});
  const fixed = typeof options.roles === 'string' ? undefined : options.roles;
  if (fixed !== undefined && fixed.length === 0) {
    throw new TypeError('PermDock: fromJunction needs at least one role');
  }
  const managedColumn =
    options.managedBy === undefined
      ? undefined
      : options.managedBy === 'idp'
        ? ''
        : options.managedBy.column;
  const groupColumn =
    options.group === undefined || typeof options.group === 'string'
      ? undefined
      : options.group.column;
  const shape: Shape = {
    table: options.table,
    user: options.user ?? 'user_id',
    scope: `${literal(options.scope)}::text`,
    id: `${col(idColumn)}::text`,
    within:
      withinEntries.length === 0
        ? 'null::jsonb'
        : `jsonb_build_object(${withinEntries.map(([name, column]) => `${literal(name)}, ${col(column)}::text`).join(', ')})`,
    roles:
      fixed === undefined
        ? `jsonb_agg(distinct ${col(options.roles as string)}::text order by ${col(options.roles as string)}::text)`
        : `jsonb_build_array(${fixed.map(literal).join(', ')})`,
    via:
      options.via === undefined
        ? 'null::text'
        : `${literal(options.via)}::text`,
    expiresAt: options.expiresAt,
    grantedBy:
      options.grantedBy === undefined
        ? 'null::text'
        : `${col(options.grantedBy)}::text`,
    reason:
      options.reason === undefined
        ? 'null::text'
        : `${col(options.reason)}::text`,
    memberGroup:
      options.group === undefined
        ? 'null::text'
        : typeof options.group === 'string'
          ? `${literal(options.group)}::text`
          : `${col(options.group.column)}::text`,
    managed:
      managedColumn === undefined
        ? 'null::text'
        : managedColumn === ''
          ? `'idp'::text`
          : `${col(managedColumn)}::text`,
    managedColumn,
    seats:
      options.seats === undefined
        ? 'null::jsonb'
        : `to_jsonb(${col(options.seats)})`,
    idOf: (name) => {
      if (name === options.scope) {
        return `${col(idColumn)}::text`;
      }
      const column = options.within?.[name];
      return column === undefined ? undefined : `${col(column)}::text`;
    },
    groupBy: [
      col(idColumn),
      ...withinEntries.map(([, column]) => col(column)),
      ...[
        options.expiresAt,
        options.grantedBy,
        options.reason,
        groupColumn,
        managedColumn === '' ? undefined : managedColumn,
        options.seats,
      ]
        .filter((name): name is string => name !== undefined)
        .map(col),
    ],
    suspension: options.suspension,
  };
  const sql = sqlOf(shape);
  return sourceOf(
    {
      ...sql,
      scope: options.scope,
      holds: [options.scope, ...withinEntries.map(([name]) => name)],
      list: () =>
        selectOf(
          shape,
          filters(
            shape,
            `$1::text = ${literal(options.scope)} and ${col(idColumn)}::text = $2::text`,
          ),
          true,
        ),
    },
    options.query,
  );
}

export const AUTHZ_VERSION_TABLE = 'permdock_authz_version';

export { supabaseMembershipsBudget } from './budget.ts';

/**
 * Reads the authorization version `permdock supabase hook generate` keeps in
 * `<schema>.permdock_authz_version`: pass it to `claimsFirst(sources, { version })`.
 */
export function authzVersion(options: {
  readonly query: SqlQuery;
  readonly schema?: string;
}): NonNullable<MembershipSource['version']> {
  const table = qualified(
    `${options.schema ?? 'public'}.${AUTHZ_VERSION_TABLE}`,
  );
  return async (principal) => {
    const rows = rowsOf(
      await options.query(`select version from ${table} where user_id = $1`, [
        principal.id,
      ]),
    );
    const value = rows[0]?.version;
    const version =
      typeof value === 'number'
        ? value
        : value === undefined
          ? 0
          : Number(value);
    return Number.isFinite(version) ? version : undefined;
  };
}
