import { describe, expect, it } from 'vitest';

import type { RlsSqlContext } from '../../src/cli/rls-sql.ts';
import type { Condition } from '../../src/index.ts';

import {
  activeInstancesSql,
  activeRowSql,
  andConditions,
  arrayColumnsOf,
  checkSuspension,
  claimPath,
  columnTypesOf,
  compileConditionSql,
  contextRefs,
  graphSqlText,
  linkHelper,
  memberIdsHelper,
  parseMembershipsFlag,
  permittedIdsHelper,
  qualifiedTable,
  scopeTable,
  scopeTypeOf,
  sqlFunctionNames,
  subjectClaimJsonSql,
  subjectClaimSql,
  tenantTypeOf,
} from '../../src/cli/rls-sql.ts';

const scopes = [
  { name: 'org', key: 'org_id' },
  { name: 'team', key: 'team_id', within: 'org' },
  { name: 'project', key: 'project_id', within: 'team' },
];

function ctx(extra: Partial<RlsSqlContext> = {}): RlsSqlContext {
  return {
    dialect: 'supabase',
    scopes,
    tenantClaim: 'tenant_id',
    gucPrefix: 'app',
    ...extra,
  };
}

const sql = (condition: Condition, extra: Partial<RlsSqlContext> = {}) =>
  compileConditionSql(condition, ctx(extra));

describe('suspension rows', () => {
  it('checks an active row by disabledAt and by status', () => {
    expect(
      activeRowSql(
        { table: 'app.users', id: 'id', disabledAt: 'banned_at' },
        'x',
      ),
    ).toBe(
      'exists (select 1 from "app"."users" s where s."id" = x and s."banned_at" is null)',
    );
    expect(
      activeRowSql({ table: 'users', id: 'id', status: 'state' }, 'x'),
    ).toBe(
      'exists (select 1 from "public"."users" s where s."id" = x and s."state"::text = any(array[]::text[]))',
    );
  });

  it.each([
    [
      { users: { table: 'users', id: 'id' } },
      'rls.suspension.users needs disabledAt or status',
    ],
    [
      { users: { table: 'users', id: 'id', status: 's' } },
      'rls.suspension.users.status needs the active values',
    ],
    [
      { users: { table: 'users', id: 'id', status: 's', active: [] } },
      'needs the active values',
    ],
    [
      { scopes: { nope: { table: 't', id: 'id', disabledAt: 'd' } } },
      'rls.suspension.scopes.nope names a scope',
    ],
  ])('refuses %j', (suspension, message) => {
    expect(() => checkSuspension(suspension, scopes)).toThrow(message);
  });

  it('keys scopes by declared name and drops an empty scope map', () => {
    expect(
      checkSuspension(
        { scopes: { tenant: { table: 'orgs', id: 'id', disabledAt: 'd' } } },
        scopes,
      ),
    ).toEqual({
      scopes: { org: { table: 'orgs', id: 'id', disabledAt: 'd' } },
    });
    expect(checkSuspension({ scopes: {} }, scopes)).toEqual({});
    expect(checkSuspension(undefined, scopes)).toBeUndefined();
  });

  it('needs the ancestor id on a suspendable chain', () => {
    const suspended = ctx({
      suspension: {
        scopes: { org: { table: 'orgs', id: 'id', disabledAt: 'd' } },
      },
    });
    expect(
      activeInstancesSql(suspended, 'team', (name) =>
        name === 'org' ? 'm.org_id' : 'm.team_id',
      ),
    ).toEqual([
      'exists (select 1 from "public"."orgs" s where s."id" = (m.org_id)::uuid and s."d" is null)',
    ]);
    expect(() =>
      activeInstancesSql(suspended, 'team', () => undefined),
    ).toThrow('rls.suspension.scopes.org needs the org id on team memberships');
  });
});

describe('types and names', () => {
  it('reads scope types by declaration, then position', () => {
    const typed = ctx({
      tenantType: 'text',
      teamType: 'bigint',
      scopeTypes: { project: 'int' },
    });
    expect([
      scopeTypeOf(typed, 'org'),
      scopeTypeOf(typed, 'team'),
      scopeTypeOf(typed, 'project'),
    ]).toEqual(['text', 'bigint', 'int']);
    expect(scopeTypeOf(ctx({ tenantType: 'text' }), 'team')).toBe('text');
    expect(() =>
      tenantTypeOf(ctx({ tenantType: 'uuid; drop table x' })),
    ).toThrow("unsafe SQL type 'uuid; drop table x'");
  });

  it('refuses unsafe helper, link and claim names', () => {
    expect(() => permittedIdsHelper('Org')).toThrow("unsafe scope name 'Org'");
    expect(() => memberIdsHelper('org-x')).toThrow("unsafe scope name 'org-x'");
    expect(() => linkHelper('doc', 'Folder')).toThrow(
      "link 'Folder' on doc is not a lowercase SQL name",
    );
    expect(linkHelper('doc', 'folder')).toBe('permdock_link_doc_folder');
    expect(() => subjectClaimSql(ctx(), 'a-b')).toThrow(
      "unsafe claim name 'a-b'",
    );
    expect(() => subjectClaimJsonSql(ctx(), 'a b')).toThrow(
      "unsafe claim name 'a b'",
    );
  });

  it.each([
    ['supabase', `((select auth.jwt()) -> 'org')`],
    ['neon', `((select auth.session()) -> 'org')`],
    ['guc', `nullif((select current_setting('app.org', true)), '')::jsonb`],
  ] as const)('reads a %s claim as jsonb', (dialect, expected) => {
    expect(subjectClaimJsonSql(ctx({ dialect }), 'org')).toBe(expected);
  });

  it('qualifies tables and renders graph parts', () => {
    expect(qualifiedTable('docs')).toBe('public.docs');
    expect(qualifiedTable('app.docs')).toBe('app.docs');
    expect(
      graphSqlText(
        [
          { text: 'x = ' },
          { value: 3 },
          { text: ' and ' },
          { column: 'id' },
          { text: ' = ' },
          { subject: true },
          { value: "it's" },
        ],
        ctx({ dialect: 'neon' }),
      ),
    ).toBe(`x = 3 and "id" = (select auth.user_id())'it''s'`);
  });

  it('bounds claim paths', () => {
    expect(claimPath('principal.claims.a.b')).toEqual(['a', 'b']);
    expect(claimPath('principal.id')).toBeUndefined();
    expect(() =>
      claimPath(
        `principal.claim.${Array.from({ length: 9 }, () => 'a').join('.')}`,
      ),
    ).toThrow('is deeper than 8');
    expect(() => claimPath('principal.claim.__proto__')).toThrow(
      "unsafe claim name '__proto__'",
    );
  });
});

describe('column types from JSON Schema', () => {
  it('maps numbers, booleans, formats and nullable variants', () => {
    expect(
      columnTypesOf({
        properties: {
          n: { type: 'integer' },
          f: { type: ['number', 'null'] },
          b: { type: 'boolean' },
          at: { type: 'string', format: 'date-time' },
          day: { type: 'string', format: 'date' },
          id: { type: 'string', format: 'uuid' },
          s: { type: 'string' },
          any: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          one: { oneOf: [{ type: 'boolean' }] },
          two: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
          many: { type: ['integer', 'string'] },
          obj: { type: 'object' },
          junk: 3,
          __proto__: { type: 'integer' },
        },
      }),
    ).toEqual({
      n: 'numeric',
      f: 'numeric',
      b: 'boolean',
      at: 'timestamptz',
      day: 'date',
      id: 'uuid',
      any: 'numeric',
      one: 'boolean',
    });
    expect(columnTypesOf(null)).toEqual({});
    expect(columnTypesOf({ properties: [] })).toEqual({});
  });

  it('maps array columns to their item type', () => {
    expect(
      arrayColumnsOf({
        properties: {
          tags: { type: 'array', items: { type: 'string' } },
          ids: {
            type: ['array', 'null'],
            items: { type: 'string', format: 'uuid' },
          },
          n: { type: 'integer' },
          junk: 'x',
        },
      }),
    ).toEqual({ tags: 'text', ids: 'uuid' });
    expect(arrayColumnsOf(undefined)).toEqual({});
  });
});

describe('compileConditionSql values and refs', () => {
  it.each([
    [
      { op: 'eq', field: 'at', value: { date: '2026-01-01' } },
      `"at" = '2026-01-01'`,
    ],
    [{ op: 'eq', field: 'n', value: Number.POSITIVE_INFINITY }, `"n" = null`],
    [{ op: 'ne', field: 'b', value: false }, `"b" <> false`],
    [{ op: 'gt', field: 'n', value: null }, `"n" > null`],
    [
      { op: 'eq', field: 'org', value: { ref: 'principal.tenant' } },
      `"org" = ((select auth.jwt()) ->> 'tenant_id')::uuid`,
    ],
    [
      { op: 'eq', field: 'org', value: { ref: 'principal.claim.tenant_id' } },
      `"org" = ((select auth.jwt()) ->> 'tenant_id')::uuid`,
    ],
    [{ op: 'lt', field: 'at', value: { ref: 'now' } }, `"at" < now()`],
    [{ op: 'eq', field: 'tags', value: ['a', 1] }, `"tags" = array['a', 1]`],
    [{ op: 'or', conditions: [] }, 'false'],
    [{ op: 'isNull', field: 'x', value: false }, `"x" is not null`],
    [{ op: 'opaque', sql: 'raw()', fingerprint: 'f' }, 'raw()'],
    [{ op: 'notIn', field: 's', value: ['a', 'b'] }, `"s" not in ('a', 'b')`],
  ] as const)('compiles %j', (condition, expected) => {
    expect(sql(condition)).toBe(expected);
  });

  it('casts claims to typed columns per dialect', () => {
    const columnTypes = {
      n: 'numeric',
      b: 'boolean',
      at: 'timestamptz',
      s: 'text',
    };
    expect(
      sql(
        { op: 'eq', field: 'n', value: { ref: 'principal.claim.level' } },
        { columnTypes },
      ),
    ).toBe(
      `"n" = (case when jsonb_typeof(((select auth.jwt()) -> 'level')) = 'number' then ((select auth.jwt()) ->> 'level')::numeric end)`,
    );
    expect(
      sql(
        { op: 'eq', field: 'b', value: { ref: 'principal.claims.app.flag' } },
        { columnTypes, dialect: 'neon' },
      ),
    ).toBe(
      `"b" = (case when jsonb_typeof(((select auth.session()) -> 'app' -> 'flag')) = 'boolean' then ((select auth.session()) -> 'app' ->> 'flag')::boolean end)`,
    );
    expect(
      sql(
        { op: 'eq', field: 'n', value: { ref: 'principal.claim.level' } },
        { columnTypes, dialect: 'guc' },
      ),
    ).toBe(`"n" = ((select current_setting('app.level', true))::numeric)`);
    expect(
      sql(
        { op: 'eq', field: 'at', value: { ref: 'principal.claims.app.since' } },
        { columnTypes, dialect: 'guc' },
      ),
    ).toBe(
      `"at" = ((nullif((select current_setting('app.app', true)), '')::jsonb ->> 'since')::timestamptz)`,
    );
    expect(
      sql(
        { op: 'eq', field: 's', value: { ref: 'principal.claim.x' } },
        { columnTypes },
      ),
    ).toBe(`"s" = ((select auth.jwt()) ->> 'x')`);
  });

  it('compiles in and notIn against array claims', () => {
    expect(
      sql(
        { op: 'in', field: 'n', value: { ref: 'principal.claim.levels' } },
        { columnTypes: { n: 'numeric' } },
      ),
    ).toBe(
      `"n" = any (array(select (e #>> '{}')::numeric from jsonb_array_elements(case when jsonb_typeof(((select auth.jwt()) -> 'levels')) = 'array' then ((select auth.jwt()) -> 'levels') else '[]'::jsonb end) e where jsonb_typeof(e) = 'number'))`,
    );
    expect(
      sql({ op: 'notIn', field: 's', value: { ref: 'principal.claim.tags' } }),
    ).toContain(
      `("s" is not null and not ("s" = any (array(select (e #>> '{}') from`,
    );
    expect(() =>
      sql({ op: 'in', field: 's', value: { ref: 'principal.id' } }),
    ).toThrow("non-portable in against 'principal.id'");
  });

  it('compiles contains on text and on array columns', () => {
    expect(sql({ op: 'contains', field: 'name', value: 'a_b' })).toBe(
      `"name"::text like '%' || replace(replace(replace('a_b'::text, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' escape '\\'`,
    );
    expect(
      sql(
        { op: 'contains', field: 'tags', value: 'x' },
        { arrayColumns: { tags: 'text' } },
      ),
    ).toBe(`'x' = any("tags")`);
  });

  it.each([
    [{ ref: 'context.ip' }, "'context.ip' is request context"],
    [{ ref: 'principal.email' }, "non-portable subject ref 'principal.email'"],
  ])('refuses the ref %j', (value, message) => {
    expect(() => sql({ op: 'eq', field: 'x', value })).toThrow(message);
  });

  it('refuses a value it cannot write', () => {
    // SAFETY: a value no condition schema admits, to reach the fail-closed throw.
    const odd = {
      op: 'eq',
      field: 'x',
      value: Symbol('x'),
    } as unknown as Condition;
    expect(() => sql(odd)).toThrow('non-portable condition value');
  });

  it('writes a sqlFunction call or its inline twin', () => {
    const call: Condition = {
      op: 'sqlFunction',
      name: 'app.job_ok',
      args: [{ field: 'id' }, { ref: 'principal.id' }, 'x'],
      twin: { op: 'eq', field: 'owner', value: { ref: 'principal.id' } },
    };
    expect(sql(call)).toBe(`"app"."job_ok"("id", (select auth.uid()), 'x')`);
    expect(sql(call, { inlineFunctions: true })).toBe(
      `"owner" = (select auth.uid())`,
    );
  });
});

describe('compileConditionSql memberOf', () => {
  const memberships = {
    scopes: {
      team: {
        table: 'team_members',
        user: 'user_id',
        role: 'role',
        via: 'via',
        expiresAt: 'expires_at',
        columns: { team: 'team_id', org: 'org_id' },
      },
    },
    resource: {
      doc: {
        table: 'doc_members',
        user: 'user_id',
        role: 'role',
        id: 'doc_id',
      },
      folder: {
        table: 'folder_members',
        user: 'user_id',
        role: 'role',
        id: 'folder_id',
      },
      noid: { table: 'x_members', user: 'user_id', role: 'role' },
    },
  };

  it('scopes a non-root membership to the active tenant and filters kinds', () => {
    const out = sql(
      {
        op: 'memberOf',
        scope: 'team',
        field: 'team_id',
        roles: ['lead', "o'k"],
      },
      {
        memberships,
        ownership: { kinds: { lead: ['staff'] }, assigns: [], counted: [] },
      },
    );
    expect(out).toContain(`m."role" = any('{lead,o''k}')`);
    expect(out).toContain(
      `case m."role"::text when 'lead' then coalesce(m."via"::text, '') = any(array['staff']::text[]) else true end`,
    );
    expect(out).toContain(`(m."expires_at" is null or m."expires_at" > now())`);
    expect(out).toContain(
      `m."org_id" = ((select auth.jwt()) ->> 'tenant_id')::uuid`,
    );
  });

  it('uses the role kind check for a single role', () => {
    const out = sql(
      { op: 'memberOf', scope: 'team', field: 'team_id', roles: ['lead'] },
      {
        memberships,
        ownership: { kinds: { lead: ['staff'] }, assigns: [], counted: [] },
      },
    );
    expect(out).toContain(
      `coalesce(m."via"::text, '') = any(array['staff']::text[])`,
    );
  });

  it('walks resource parents through their own tables', () => {
    const out = sql(
      {
        op: 'memberOf',
        scope: 'resource',
        resource: 'doc',
        field: 'id',
        roles: [],
        parents: [
          'parent_id',
          { resource: 'folder', field: 'folder_id' },
          { resource: 'noid', field: 'x' },
          { resource: 'gone', field: 'y' },
        ],
      },
      { memberships },
    );
    expect(out).toBe(
      `(exists (select 1 from "doc_members" m where m."doc_id" = "id" and m."user_id" = (select auth.uid())) or exists (select 1 from "doc_members" m where m."doc_id" = "parent_id" and m."user_id" = (select auth.uid())) or exists (select 1 from "folder_members" m where m."folder_id" = "folder_id" and m."user_id" = (select auth.uid())))`,
    );
  });

  it.each([
    [
      { op: 'memberOf', scope: 'region', field: 'r', roles: [] },
      'memberOf region names a scope the policy does not declare',
    ],
    [
      {
        op: 'memberOf',
        scope: 'resource',
        resource: 'noid',
        field: 'id',
        roles: [],
      },
      'memberships mapping for resource is missing the row column',
    ],
    [
      { op: 'memberOf', scope: 'resource', field: 'id', roles: [] },
      'memberOf resource needs a memberships table mapping',
    ],
    [
      { op: 'memberOf', scope: 'project', field: 'p', roles: [] },
      'memberOf project needs a memberships table mapping',
    ],
  ] as const)('refuses %j', (condition, message) => {
    expect(() => sql(condition, { memberships })).toThrow(message);
  });

  it('reads the root scope from the tenant claim with suspension checks', () => {
    expect(
      sql({ op: 'memberOf', scope: 'org', field: 'org_id', roles: [] }),
    ).toBe(`"org_id" = ((select auth.jwt()) ->> 'tenant_id')::uuid`);
    expect(
      sql(
        { op: 'memberOf', scope: 'org', field: 'org_id', roles: [] },
        {
          suspension: {
            users: { table: 'users', id: 'id', disabledAt: 'd' },
            scopes: { org: { table: 'orgs', id: 'id', disabledAt: 'd' } },
          },
        },
      ),
    ).toBe(
      `("org_id" = ((select auth.jwt()) ->> 'tenant_id')::uuid and exists (select 1 from "public"."users" s where s."id" = (select auth.uid()) and s."d" is null) and exists (select 1 from "public"."orgs" s where s."id" = ("org_id")::uuid and s."d" is null))`,
    );
  });

  it('reads a sourced scope through member_<scope>_ids in database mode', () => {
    const source = {
      sql: { table: 'm', columns: ['user_id'], scope: 'team' },
    };
    expect(
      sql(
        { op: 'memberOf', scope: 'team', field: 'team_id', roles: [] },
        // SAFETY: scopeSources reads only sql.scope of a source.
        { authorize: 'database', sources: [source as never], schema: 'authz' },
      ),
    ).toBe(`"team_id" in (select "authz".member_team_ids())`);
  });
});

describe('compileConditionSql related', () => {
  it('reads the helper directly at depth 0 and through the closure with a cap', () => {
    const related = {
      op: 'related',
      resource: 'folder',
      relation: 'viewer',
      field: 'folder_id',
      depth: 0,
    } as const;
    expect(sql(related)).toBe(
      `"folder_id"::text in (select "permdock".permitted_folder_ids('viewer'))`,
    );
    expect(sql(related, { columnTypes: { folder_id: 'uuid' } })).toBe(
      `"folder_id" in (select p.id::uuid from "permdock".permitted_folder_ids('viewer') as p(id))`,
    );
    expect(
      sql(
        { ...related, depth: 3 },
        {
          graph: { closures: { folder: 8 } },
          columnTypes: { folder_id: 'text' },
        },
      ),
    ).toBe(
      `"folder_id" in (select descendant from "permdock".permdock_closure where resource = 'folder' and depth <= 3 and ancestor = any (array(select "permdock".permitted_folder_ids('viewer'))))`,
    );
    expect(
      sql(
        { ...related, depth: 8, parent: true, restricted: 'restricted' },
        { graph: { closures: { folder: 8 } } },
      ),
    ).toBe(
      `("folder_id"::text in (select descendant from "permdock".permdock_closure where resource = 'folder' and ancestor = any (array(select "permdock".permitted_folder_ids('viewer')))) and "restricted" is not true)`,
    );
  });

  it('needs the policy resources for link hops', () => {
    expect(() =>
      sql({
        op: 'related',
        resource: 'team',
        relation: 'lead',
        field: 'folder_id',
        depth: 0,
        hops: [{ resource: 'folder', link: 'team' }],
      }),
    ).toThrow('a related condition with link hops needs the policy resources');
  });
});

describe('condition walkers and flags', () => {
  it('lists context refs and function names', () => {
    const condition: Condition = {
      op: 'and',
      conditions: [
        { op: 'eq', field: 'a', value: { ref: 'context.ip' } },
        { op: 'in', field: 'b', value: [{ ref: 'context' }, 'x'] },
        { op: 'not', condition: { op: 'isNull', field: 'c', value: true } },
        {
          op: 'sqlFunction',
          name: 'f',
          args: [{ ref: 'context.org' }],
          twin: {
            op: 'or',
            conditions: [{ op: 'eq', field: 'd', value: { ref: 'context.d' } }],
          },
        },
        { op: 'memberOf', scope: 'org', field: 'org_id', roles: [] },
      ],
    };
    expect(contextRefs(condition)).toEqual([
      'context.ip',
      'context',
      'context.org',
      'context.d',
    ]);
    expect(contextRefs(undefined)).toEqual([]);
    expect(sqlFunctionNames(condition)).toEqual(['f']);
  });

  it('parses --memberships with defaults and an expiry column', () => {
    expect(parseMembershipsFlag('')).toBeUndefined();
    expect(parseMembershipsFlag('members')).toEqual({
      tenant: {
        table: 'members',
        tenant: 'tenant_id',
        user: 'user_id',
        role: 'role',
      },
    });
    expect(parseMembershipsFlag('members:org, uid, r, until')).toEqual({
      tenant: {
        table: 'members',
        tenant: 'org',
        user: 'uid',
        role: 'r',
        expiresAt: 'until',
      },
    });
  });

  it('ands two optional conditions', () => {
    const a: Condition = { op: 'eq', field: 'a', value: 1 };
    expect(andConditions(undefined, a)).toBe(a);
    expect(andConditions(a, undefined)).toBe(a);
    expect(andConditions(a, a)).toEqual({ op: 'and', conditions: [a, a] });
  });

  it('maps a scope table only with the scope column', () => {
    expect(
      scopeTable(
        ctx({
          memberships: {
            scopes: { team: { table: 't', user: 'u', role: 'r' } },
          },
        }),
        'team',
      ),
    ).toBeUndefined();
  });
});
