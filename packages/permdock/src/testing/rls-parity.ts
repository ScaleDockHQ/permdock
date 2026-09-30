import { membershipsClaim } from '../core/custom-roles.ts';
import { type Scope, scopeList } from '../core/scopes.ts';
import {
  createPermDock,
  fromSnapshot,
  memoryRoleSource,
  parseSnapshot,
  type CustomRole,
  type Membership,
  type Permission,
  type Policy,
  type Subject,
} from '../index.ts';
import { supabaseTenantClaim } from '../supabase/budget.ts';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type RlsDbOutcome = 'allowed' | 'filtered' | 'rejected';

export type RlsParitySubject = {
  readonly id: string;
  readonly roles?: readonly string[];
  readonly tenant?: string;
  readonly memberships?: readonly Membership[];
  /**
   * Extra token claims, read in memory as `principal.claims.*`. They join the
   * JWT claims (`supabase`, `neon`); under `guc` each top-level claim is its
   * own `<prefix>.<name>` setting, strings as is and anything else as JSON.
   */
  readonly claims?: Readonly<Record<string, unknown>>;
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
  /**
   * `supabase` and `neon` set `request.jwt.claims`; a test database stubs
   * `auth.jwt()` / `auth.uid()` or `auth.session()` / `auth.user_id()` over it.
   */
  readonly dialect?: 'supabase' | 'neon' | 'guc';
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
  /** Also decide each case from the subject's serialized snapshot (`fromSnapshot`); it must agree. */
  readonly snapshot?: boolean;
  /**
   * With `rls generate --fields views`: for each instance read, the row of
   * `<table>_visible` must hold exactly the columns `pick` keeps (plus the key,
   * which always passes through). A table with no view is read directly.
   */
  readonly fieldViews?: boolean;
};

/** Columns with a value in the view's row and in `pick`'s result, sorted. */
export type RlsFieldsOutcome = {
  readonly app: readonly string[];
  readonly database: readonly string[] | string;
};

export type RlsParityCase = {
  readonly name: string;
  readonly granted: boolean;
  readonly database: RlsDbOutcome;
  /** The snapshot's decision, with `snapshot: true`. */
  readonly snapshot?: boolean;
  /** The field view check, with `fieldViews: true`; `database` is an error code when the read failed. */
  readonly fields?: RlsFieldsOutcome;
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
      ...(input.claims === undefined ? {} : { claims: input.claims }),
    },
    context: {},
  };
}

function rowId(row: Readonly<Record<string, unknown>>): unknown {
  return row['id'];
}

type Setting = { readonly sql: string; readonly values: readonly unknown[] };

function setting(name: string, value: string): Setting {
  return { sql: 'select set_config($1, $2, true)', values: [name, value] };
}

/**
 * The session state the generated helpers read: JWT claims for `supabase`,
 * GUCs for `guc` (roles as a comma list, memberships as JSON).
 */
function subjectSettings(
  dialect: 'supabase' | 'neon' | 'guc',
  subject: RlsParitySubject,
  gucPrefix: string,
  tenantClaim: string,
  roleClaim: string,
  customRoles: readonly CustomRole[],
  scopes: readonly Scope[],
): readonly Setting[] {
  const roles = subject.roles ?? [];
  const memberships = membershipsClaim(
    subject.memberships ?? [],
    customRoles,
    scopes,
  );
  if (dialect === 'supabase' || dialect === 'neon') {
    const claims = {
      ...subject.claims,
      sub: subject.id,
      role: 'authenticated',
      [roleClaim]: roles.length === 1 ? roles[0] : roles,
      [tenantClaim]: subject.tenant,
      memberships,
    };
    return [setting('request.jwt.claims', JSON.stringify(claims))];
  }
  const settings = [
    ...Object.entries(subject.claims ?? {}).map(([name, value]) => {
      if (!IDENT.test(name)) {
        throw new Error(`PermDock: unsafe claim name '${name}'`);
      }
      return setting(
        `${gucPrefix}.${name}`,
        typeof value === 'string' ? value : JSON.stringify(value),
      );
    }),
    setting(`${gucPrefix}.user_id`, subject.id),
    setting(`${gucPrefix}.${roleClaim}`, roles.join(',')),
    setting(`${gucPrefix}.memberships`, JSON.stringify(memberships)),
  ];
  return subject.tenant === undefined
    ? settings
    : [...settings, setting(`${gucPrefix}.${tenantClaim}`, subject.tenant)];
}

/**
 * The statement a case runs. With field views it reads back only the key, so
 * a base table whose restricted columns are revoked does not reject it.
 */
function statementSql(action: string, table: string, keyOnly: boolean): string {
  const quoted = quoteIdent(table);
  const id = quoteIdent('id');
  const back = keyOnly ? id : '*';
  switch (action) {
    case 'read':
    case 'list':
    case 'get':
      return `select ${back} from ${quoted} where ${id} = $1`;
    case 'update':
      return `update ${quoted} set ${id} = ${id} where ${id} = $1 returning ${back}`;
    case 'create':
      return `insert into ${quoted} (${id}) values ($1) returning ${back}`;
    case 'delete':
      return `delete from ${quoted} where ${id} = $1 returning ${back}`;
    default:
      return `select ${back} from ${quoted} where ${id} = $1`;
  }
}

function valued(row: unknown): readonly string[] {
  if (row === null || typeof row !== 'object') {
    return [];
  }
  // SAFETY: row was checked to be a non-null object above; values stay unknown.
  const record = row as Readonly<Record<string, unknown>>;
  return Object.keys(record)
    .filter((name) => record[name] !== null && record[name] !== undefined)
    .toSorted();
}

function isRead(action: string): boolean {
  return action === 'read' || action === 'get' || action === 'list';
}

async function viewColumns(
  query: RlsQueryFn,
  table: string,
  key: unknown,
): Promise<readonly string[] | string> {
  const id = quoteIdent('id');
  await query('savepoint permdock_fields');
  const view = await query(
    `select * from ${quoteIdent(`${table}_visible`)} where ${id} = $1`,
    [key],
  );
  if (view.code === undefined) {
    return valued(view.rows[0]);
  }
  await query('rollback to savepoint permdock_fields');
  if (view.code !== '42P01') {
    return view.code;
  }
  const base = await query(
    `select * from ${quoteIdent(table)} where ${id} = $1`,
    [key],
  );
  return base.code ?? valued(base.rows[0]);
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
  const tenantClaim = options.tenantClaim ?? supabaseTenantClaim;
  const roleClaim = options.roleClaim ?? 'user_role';
  const role = options.role ?? 'authenticated';
  const customRoles = options.customRoles ?? [];
  const scopes = scopeList(policy.scopes);

  async function runCase(fixture: RlsParityFixture): Promise<RlsParityCase> {
    // SAFETY: TUser is erased at the policy boundary; toSubject builds the Subject createPermDock reads.
    const dock = await createPermDock(
      policy,
      toSubject(fixture.subject) as TUser,
      { customRoles: memoryRoleSource(customRoles) },
    );
    // SAFETY: each branch casts to the kind just checked; Permission's kind parameter does not narrow.
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
    let fromClient: boolean | undefined;
    if (options.snapshot === true) {
      const snapshot = dock.snapshot();
      if (typeof snapshot !== 'object' || snapshot instanceof Promise) {
        throw new TypeError('PermDock: rlsParity needs an unsigned snapshot');
      }
      // SAFETY: the snapshot client's can() treats both kinds alike at runtime; the row is optional.
      fromClient = fromSnapshot(parseSnapshot(JSON.stringify(snapshot))).can(
        fixture.permission as Permission<string, unknown, 'instance'>,
        fixture.row,
      );
    }
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
        scopes,
      )) {
        await options.query(item.sql, item.values);
      }
      const result = await options.query(
        statementSql(
          fixture.permission.action,
          fixture.table,
          options.fieldViews === true,
        ),
        [rowId(fixture.row)],
      );
      const database = dbOutcome(result);
      const agrees = granted
        ? database === 'allowed'
        : database === 'filtered' || database === 'rejected';
      let fields: RlsFieldsOutcome | undefined;
      if (
        options.fieldViews === true &&
        fixture.permission.kind === 'instance' &&
        isRead(fixture.permission.action)
      ) {
        const key =
          policy.resources.get(fixture.permission.resource)?.id ?? 'id';
        // SAFETY: the if above checked fixture.permission.kind === 'instance'.
        const kept = new Set(
          granted
            ? valued(
                dock.pick(
                  fixture.permission as Permission<string, unknown, 'instance'>,
                  fixture.row,
                ),
              )
            : [],
        );
        if (
          granted &&
          fixture.row[key] !== null &&
          fixture.row[key] !== undefined
        ) {
          kept.add(key);
        }
        fields = {
          app: [...kept].toSorted(),
          database: await viewColumns(
            options.query,
            fixture.table,
            rowId(fixture.row),
          ),
        };
      }
      const fieldsOk =
        fields === undefined ||
        (typeof fields.database !== 'string' &&
          fields.database.join('\u0000') === fields.app.join('\u0000'));
      const ok =
        agrees &&
        fieldsOk &&
        (fromClient === undefined || fromClient === granted);
      return {
        name: fixture.name,
        granted,
        database,
        ...(fromClient === undefined ? {} : { snapshot: fromClient }),
        ...(fields === undefined ? {} : { fields }),
        ok,
      };
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
