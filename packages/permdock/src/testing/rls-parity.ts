import {
  createPermDock,
  customRoleClaim,
  memoryRoleSource,
  type CustomRole,
  type Permission,
  type Policy,
  type Subject,
} from '../index.ts';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type RlsDbOutcome = 'allowed' | 'filtered' | 'rejected';

export type RlsParitySubject = {
  readonly id: string;
  readonly roles?: readonly string[];
  readonly tenant?: string;
  readonly memberships?: readonly {
    readonly tenant?: string;
    readonly team?: string;
    readonly roles: readonly string[];
  }[];
};

export type RlsParityFixture = {
  readonly name: string;
  readonly subject: RlsParitySubject;
  readonly permission: Permission;
  readonly row: Readonly<Record<string, unknown>>;
  readonly table: string;
};

export type RlsQueryResult = {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount?: number;
  readonly code?: string;
};

export type RlsQueryFn = (
  sql: string,
  values?: readonly unknown[],
) => Promise<RlsQueryResult>;

export type RlsParityOptions = {
  readonly query: RlsQueryFn;
  readonly fixtures: readonly RlsParityFixture[];
  readonly dialect?: 'supabase' | 'guc';
  readonly gucPrefix?: string;
  readonly tenantClaim?: string;
  /** Claim (or `guc` setting) the RLS helpers read global roles from. Default `user_role`. */
  readonly roleClaim?: string;
  readonly role?: 'authenticated' | 'anon';
  /**
   * Tenant-defined roles the subjects' memberships may hold. `decide` resolves them through a
   * `RoleSource`; each membership's claim carries them as the compact `grants` map, which the
   * helpers read in `jwt` mode. Seeding the `database`-mode tables is the caller's job.
   */
  readonly customRoles?: readonly CustomRole[];
};

export type RlsParityCase = {
  readonly name: string;
  readonly granted: boolean;
  readonly database: RlsDbOutcome;
  readonly ok: boolean;
};

export type RlsParityReport = {
  readonly ok: boolean;
  readonly results: readonly RlsParityCase[];
};

function quoteIdent(name: string): string {
  if (!IDENT.test(name)) {
    throw new Error(`PermDock: unsafe SQL identifier '${name}'`);
  }
  return `"${name}"`;
}

function toSubject(input: RlsParitySubject): Subject {
  return {
    principal: {
      id: input.id,
      roles: input.roles ?? [],
      ...(input.tenant === undefined ? {} : { tenant: input.tenant }),
      memberships: input.memberships ?? [],
    },
    context: {},
  };
}

function rowId(row: Readonly<Record<string, unknown>>): unknown {
  return row.id;
}

type Setting = { readonly sql: string; readonly values: readonly unknown[] };

function setting(name: string, value: string): Setting {
  return { sql: 'select set_config($1, $2, true)', values: [name, value] };
}

/**
 * The session state the generated helpers read: JWT claims for `supabase`,
 * GUCs for `guc` (roles as a comma list, memberships as JSON).
 */
function claimMemberships(
  subject: RlsParitySubject,
  customRoles: readonly CustomRole[],
): readonly Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const membership of subject.memberships ?? []) {
    const held = customRoles.filter(
      (role) =>
        role.tenant === membership.tenant &&
        role.team === membership.team &&
        membership.roles.includes(role.name),
    );
    out.push(
      held.length === 0
        ? membership
        : { ...membership, grants: customRoleClaim(held) },
    );
  }
  return out;
}

function subjectSettings(
  dialect: 'supabase' | 'guc',
  subject: RlsParitySubject,
  gucPrefix: string,
  tenantClaim: string,
  roleClaim: string,
  customRoles: readonly CustomRole[],
): readonly Setting[] {
  const roles = subject.roles ?? [];
  const memberships = claimMemberships(subject, customRoles);
  if (dialect === 'supabase') {
    const claims = {
      sub: subject.id,
      role: 'authenticated',
      [roleClaim]: roles.length === 1 ? roles[0] : roles,
      [tenantClaim]: subject.tenant,
      memberships,
    };
    return [setting('request.jwt.claims', JSON.stringify(claims))];
  }
  const settings = [
    setting(`${gucPrefix}.user_id`, subject.id),
    setting(`${gucPrefix}.${roleClaim}`, roles.join(',')),
    setting(`${gucPrefix}.memberships`, JSON.stringify(memberships)),
  ];
  return subject.tenant === undefined
    ? settings
    : [...settings, setting(`${gucPrefix}.${tenantClaim}`, subject.tenant)];
}

function statementSql(action: string, table: string): string {
  const quoted = quoteIdent(table);
  const id = quoteIdent('id');
  switch (action) {
    case 'read':
    case 'list':
    case 'get':
      return `select * from ${quoted} where ${id} = $1`;
    case 'update':
      return `update ${quoted} set ${id} = ${id} where ${id} = $1 returning *`;
    case 'create':
      return `insert into ${quoted} (${id}) values ($1) returning *`;
    case 'delete':
      return `delete from ${quoted} where ${id} = $1 returning *`;
    default:
      return `select * from ${quoted} where ${id} = $1`;
  }
}

function dbOutcome(result: RlsQueryResult): RlsDbOutcome {
  if (result.code === '42501') {
    return 'rejected';
  }
  const count = result.rowCount ?? result.rows.length;
  return count > 0 ? 'allowed' : 'filtered';
}

export async function rlsParity<TUser>(
  policy: Policy<TUser>,
  options: RlsParityOptions,
): Promise<RlsParityReport> {
  const dialect = options.dialect ?? 'guc';
  const gucPrefix = options.gucPrefix ?? 'app';
  const tenantClaim = options.tenantClaim ?? 'tenant_id';
  const roleClaim = options.roleClaim ?? 'user_role';
  const role = options.role ?? 'authenticated';
  const customRoles = options.customRoles ?? [];

  async function runCase(fixture: RlsParityFixture): Promise<RlsParityCase> {
    const dock = await createPermDock(
      policy,
      toSubject(fixture.subject) as TUser,
      { customRoles: memoryRoleSource(customRoles) },
    );
    const granted =
      fixture.permission.kind === 'collection'
        ? dock.can(
            fixture.permission as Permission<string, unknown, 'collection'>,
            fixture.row,
          )
        : dock.can(
            fixture.permission as Permission<string, unknown, 'instance'>,
            fixture.row,
          );
    await options.query('begin');
    try {
      await options.query(`set local role ${quoteIdent(role)}`);
      for (const item of subjectSettings(
        dialect,
        fixture.subject,
        gucPrefix,
        tenantClaim,
        roleClaim,
        customRoles,
      )) {
        await options.query(item.sql, item.values);
      }
      const result = await options.query(
        statementSql(fixture.permission.action, fixture.table),
        [rowId(fixture.row)],
      );
      const database = dbOutcome(result);
      const ok = granted
        ? database === 'allowed'
        : database === 'filtered' || database === 'rejected';
      return { name: fixture.name, granted, database, ok };
    } finally {
      await options.query('rollback');
    }
  }

  async function runAll(
    remaining: readonly RlsParityFixture[],
    acc: readonly RlsParityCase[],
  ): Promise<readonly RlsParityCase[]> {
    const [head, ...tail] = remaining;
    if (head === undefined) {
      return acc;
    }
    return runAll(tail, [...acc, await runCase(head)]);
  }

  const results = await runAll(options.fixtures, []);
  return { ok: results.every((item) => item.ok), results };
}
