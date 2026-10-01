import type * as PgsqlParser from 'pgsql-parser';

import { parse } from 'pgsql-parser';
import { describe, expect, it, vi } from 'vitest';

import type { RolePermission } from '../../src/cli/rls-helpers.ts';
import type { RlsMemberships } from '../../src/cli/types.ts';

import {
  conditionFromAst,
  helperGrants,
  seedFromRow,
  seedsFromSql,
} from '../../src/cli/rls-import-ast.ts';

vi.mock('pgsql-parser', async (importOriginal) => {
  const actual = await importOriginal<typeof PgsqlParser>();
  return { ...actual, parse: vi.fn<typeof actual.parse>(actual.parse) };
});

const PRINCIPAL = { ref: 'principal.id' };

async function condition(
  sql: string,
  options: {
    readonly memberships?: RlsMemberships;
    readonly functions?: Parameters<typeof conditionFromAst>[2];
    readonly seeds?: readonly RolePermission[];
  } = {},
): Promise<{
  readonly mapped: unknown;
  readonly unmapped: string[];
  readonly joins: string[];
}> {
  const unmapped: string[] = [];
  const joins: string[] = [];
  const mapped = await conditionFromAst(
    sql,
    options.memberships,
    options.functions,
    unmapped,
    joins,
    options.seeds,
  );
  return { mapped, unmapped, joins };
}

/** Replaces the next parse with a hand-built AST, the shape older libpg-query releases return. */
function nextParse(ast: unknown): void {
  // SAFETY: the importer reads the AST through runtime guards only, so any JSON shape is a valid test input.
  vi.mocked(parse).mockResolvedValueOnce(ast as never);
}

function legacyWhere(where: unknown): unknown {
  return [{ RawStmt: { stmt: { SelectStmt: { whereClause: where } } } }];
}

const str = (value: string) => ({ String: { str: value } });
const col = (name: string) => ({ ColumnRef: { fields: [str(name)] } });
const fn = (name: string, args?: readonly unknown[]) => ({
  FuncCall: { funcname: name.split('.').map(str), args },
});
const op = (name: string, lexpr: unknown, rexpr: unknown) => ({
  A_Expr: { name: [str(name)], lexpr, rexpr },
});
const select = (val: unknown, from?: string) => ({
  SelectStmt: {
    targetList: [{ ResTarget: { val } }],
    ...(from === undefined
      ? {}
      : { fromClause: [{ RangeVar: { relname: from } }] }),
  },
});

describe('conditionFromAst comparisons', () => {
  it.each([
    ['"n" = 0', { op: 'eq', field: 'n', value: 0 }],
    ['"flag" = false', { op: 'eq', field: 'flag', value: false }],
    ['"flag" = true', { op: 'eq', field: 'flag', value: true }],
    ['"n" <> 2', { op: 'ne', field: 'n', value: 2 }],
    ['"n" > 2', { op: 'gt', field: 'n', value: 2 }],
    ['"n" >= 2', { op: 'gte', field: 'n', value: 2 }],
    ['"n" < 2', { op: 'lt', field: 'n', value: 2 }],
    ['"n" <= 2', { op: 'lte', field: 'n', value: 2 }],
    ['"s" = \'x\'::text', { op: 'eq', field: 's', value: 'x' }],
    ['"s" = null', { op: 'eq', field: 's', value: null }],
    ['auth.uid() = "owner"', { op: 'eq', field: 'owner', value: PRINCIPAL }],
    ['"owner" = auth.uid()', { op: 'eq', field: 'owner', value: PRINCIPAL }],
    [
      '"owner" = (select current_setting(\'app.user_id\'))',
      { op: 'eq', field: 'owner', value: PRINCIPAL },
    ],
    [
      '"org" = (auth.jwt() ->> \'org\')',
      { op: 'eq', field: 'org', value: { ref: 'principal.claim.org' } },
    ],
    [
      '"org" = ((select auth.session()) -> \'org\')',
      { op: 'eq', field: 'org', value: { ref: 'principal.claim.org' } },
    ],
    ['lower("a") is null', undefined],
  ])('maps %s', async (sql, expected) => {
    const { mapped } = await condition(sql);
    expect(mapped).toEqual(
      expected ?? { op: 'opaque', sql, fingerprint: expect.any(String) },
    );
  });

  it.each([
    ['1 = 1'],
    ['"a" = now()'],
    ['"a" = ("b" || \'x\')'],
    ['"a" = ("meta" ->> \'org\')'],
    ['"a" = ((select auth.uid()) ->> \'org\')'],
    ['"a" = ((select other()) ->> \'org\')'],
    ['"a" = (auth.jwt() ->> 1)'],
    ['"a" = current_setting(\'app.role\')'],
    ['"a" = current_setting()'],
    ['"a" = 1.5'],
    ['"a" like \'x%\''],
    ['a = = 1'],
  ])('keeps %s opaque', async (sql) => {
    const { mapped } = await condition(sql);
    expect(mapped).toEqual({
      op: 'opaque',
      sql,
      fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
    });
  });

  it('treats an empty expression as always true', async () => {
    expect((await condition('  ')).mapped).toEqual({
      op: 'eq',
      field: '_',
      value: true,
    });
  });
});

describe('conditionFromAst compounds', () => {
  it('maps not and keeps an unmappable branch opaque', async () => {
    expect((await condition('not ("a" = 1)')).mapped).toEqual({
      op: 'not',
      condition: { op: 'eq', field: 'a', value: 1 },
    });
    const notUnmapped = await condition('not (foo("a"))');
    expect(notUnmapped.mapped).toMatchObject({ op: 'opaque' });
    expect(notUnmapped.unmapped).toEqual(['foo']);
    const partial = await condition('"a" = 1 and foo("b")');
    expect(partial.mapped).toMatchObject({ op: 'opaque' });
    expect(partial.unmapped).toEqual(['foo']);
  });
});

describe('conditionFromAst functions', () => {
  const twin = { op: 'eq', field: 'owner', value: PRINCIPAL };

  it('reads arguments when the mapping lists none', async () => {
    const { mapped } = await condition(
      "job_permitted(\"id\", auth.uid(), current_setting('app.user_id'), 'x', 3, now())",
      { functions: { job_permitted: { twin } } },
    );
    expect(mapped).toEqual({
      op: 'sqlFunction',
      name: 'job_permitted',
      args: [{ field: 'id' }, PRINCIPAL, PRINCIPAL, 'x', 3],
      twin,
    });
  });

  it('matches a schema-qualified call by its full or its short name', async () => {
    expect(
      (
        await condition('app.job_permitted()', {
          functions: { 'app.job_permitted': { twin } },
        })
      ).mapped,
    ).toEqual({ op: 'sqlFunction', name: 'app.job_permitted', args: [], twin });
    expect(
      (
        await condition('app.job_permitted("id")', {
          functions: { job_permitted: { twin, args: ['id'] } },
        })
      ).mapped,
    ).toMatchObject({ op: 'sqlFunction', args: [{ field: 'id' }] });
  });

  it('records an unknown function even when functions are configured', async () => {
    const { unmapped } = await condition('other("id")', {
      functions: { job_permitted: { twin } },
    });
    expect(unmapped).toEqual(['other']);
  });
});

describe('conditionFromAst memberships and helpers', () => {
  const scoped: RlsMemberships = {
    scopes: {
      project: {
        table: 'project_members',
        user: 'user_id',
        role: 'role',
        columns: { project: 'project_id' },
      },
      unmappedScope: { table: 'project_members', user: 'u', role: 'r' },
    },
    tenant: { table: 'org_members', user: 'user_id', role: 'role' },
    team: { table: 'team_members', user: 'user_id', role: 'role' },
  };

  it.each([
    [
      'exists (select 1 from project_members)',
      { op: 'memberOf', scope: 'project', field: 'project_id', roles: [] },
    ],
    [
      '"org_id" in (select org_id from org_members)',
      { op: 'memberOf', scope: 'tenant', field: 'tenant_id', roles: [] },
    ],
    [
      'true = exists (select 1 from team_members)',
      { op: 'memberOf', scope: 'team', field: 'team_id', roles: [] },
    ],
    [
      '"team_id" in (select member_team_ids())',
      { op: 'memberOf', scope: 'team', field: 'team_id', roles: [] },
    ],
  ])('maps %s', async (sql, expected) => {
    expect((await condition(sql, { memberships: scoped })).mapped).toEqual(
      expected,
    );
  });

  it('records the table of an unknown membership subquery as a join', async () => {
    const { mapped, joins } = await condition('exists (select 1 from grants)', {
      memberships: scoped,
    });
    expect(mapped).toMatchObject({ op: 'opaque' });
    expect(joins).toEqual(['grants']);
    expect((await condition('exists (select 1 from grants)')).joins).toEqual([
      'grants',
    ]);
  });

  it.each([
    'exists (select 1)',
    '"x" in (select a, b from t)',
    '"x" in (select permdock_has(\'k\'))',
    "(select permitted_team_ids('k'))",
    "1 in (select permitted_team_ids('k'))",
    '1 in (select member_team_ids())',
    '"x" in (select member_team_ids(\'a\'))',
    '"x" in (select other_ids())',
    "\"x\" in (select permitted_team_ids('a', 'b'))",
    'permdock_has(1)',
  ])('keeps %s opaque', async (sql) => {
    expect((await condition(sql)).mapped).toMatchObject({ op: 'opaque' });
  });

  it('maps helper calls with the seeded roles', async () => {
    const seeds: RolePermission[] = [
      {
        role: 'editor',
        permission: 'doc.read',
        grantKey: 'doc.read',
        scope: 'team',
        effect: 'allow',
      },
      {
        role: 'editor',
        permission: 'doc.read',
        grantKey: 'doc.read',
        scope: 'team',
        effect: 'allow',
      },
    ];
    expect(
      (
        await condition(
          '"team_id" in (select permitted_team_ids(\'doc.read\'))',
          {
            seeds,
          },
        )
      ).mapped,
    ).toEqual({
      op: 'memberOf',
      scope: 'team',
      field: 'team_id',
      roles: ['editor'],
    });
    expect((await condition("public.permdock_has('it''s')")).mapped).toEqual({
      op: 'opaque',
      sql: "(select permdock_has('it''s'))",
      fingerprint: expect.any(String),
    });
  });
});

describe('helperGrants', () => {
  const seeds: RolePermission[] = [
    {
      role: 'admin',
      permission: 'doc.read',
      grantKey: 'doc.read',
      scope: 'global',
      effect: 'allow',
    },
    {
      role: 'editor',
      permission: 'doc.read',
      grantKey: 'doc.read#2',
      scope: 'team',
      effect: 'allow',
    },
  ];

  it('is empty without SQL or without helper calls', async () => {
    expect(await helperGrants(undefined, undefined, undefined, seeds)).toEqual(
      [],
    );
    expect(await helperGrants('a = = 1', undefined, undefined, seeds)).toEqual(
      [],
    );
    expect(await helperGrants('"a" = 1', undefined, undefined, seeds)).toEqual(
      [],
    );
  });

  it('reads each OR branch with its row condition', async () => {
    const grants = await helperGrants(
      `(select permdock_has('doc.read')) or ("team_id" in (select permitted_team_ids('doc.read#2')) and "a" = 1 and "b" = 2) or ("team_id" in (select permitted_team_ids('doc.write#3')) and foo())`,
      undefined,
      undefined,
      seeds,
    );
    expect(grants).toEqual([
      {
        key: 'doc.read',
        permission: 'doc.read',
        scope: 'global',
        roles: ['admin'],
      },
      {
        key: 'doc.read#2',
        permission: 'doc.read',
        scope: 'team',
        roles: ['editor'],
        where: {
          op: 'and',
          conditions: [
            { op: 'eq', field: 'a', value: 1 },
            { op: 'eq', field: 'b', value: 2 },
          ],
        },
      },
      {
        key: 'doc.write#3',
        permission: 'doc.write',
        scope: 'team',
        roles: [],
        where: {
          op: 'opaque',
          sql: expect.any(String),
          fingerprint: expect.any(String),
        },
      },
    ]);
  });

  it('reads a restrictive policy through its outer not', async () => {
    expect(
      await helperGrants(
        `not ("team_id" in (select permitted_team_ids('doc.read#2')) and "a" = 1)`,
        undefined,
        undefined,
        seeds,
      ),
    ).toEqual([
      {
        key: 'doc.read#2',
        permission: 'doc.read',
        scope: 'team',
        roles: ['editor'],
        where: { op: 'eq', field: 'a', value: 1 },
      },
    ]);
  });
});

describe('seedFromRow and seedsFromSql', () => {
  it.each([
    [{ role: 'r', permission: 'p', grant_key: 'p', scope: 'Team' }],
    [{ role: 'r', permission: 'p', grant_key: 'p', scope: 3 }],
    [{ role: 'r', permission: 'p', scope: 'team' }],
    [{ role: 'r', grant_key: 'p', scope: 'team' }],
    [{ permission: 'p', grant_key: 'p', scope: 'team' }],
  ])('refuses %j', (row) => {
    expect(seedFromRow(row)).toBeUndefined();
  });

  it('defaults the effect to allow', () => {
    expect(
      seedFromRow({
        role: 'r',
        permission: 'p',
        grant_key: 'p#1',
        scope: 'team',
        effect: 'x',
      }),
    ).toEqual({
      role: 'r',
      permission: 'p',
      grantKey: 'p#1',
      scope: 'team',
      effect: 'allow',
    });
  });

  it('reads role_permissions inserts and skips everything else', async () => {
    const sql = `
insert into public.role_permissions (role, permission, grant_key, scope, effect, extra)
values ('admin', 'doc.read', 'doc.read', 'global', 'deny', 'x'), ('bad', 'doc.read', 'doc.read', 'Bad', 'allow', 'x');
insert into public.role_permissions select * from staging;
insert into public.role_permissions values ('a', 'b', 'c', 'd', 'allow');
insert into other (a) values (1);
select 1;
`;
    expect(await seedsFromSql(sql)).toEqual([
      {
        role: 'admin',
        permission: 'doc.read',
        grantKey: 'doc.read',
        scope: 'global',
        effect: 'deny',
      },
    ]);
    expect(await seedsFromSql('insert into (')).toEqual([]);
  });
});

describe('legacy parser shapes', () => {
  it('reads str strings, flat constants and numeric enums', async () => {
    nextParse(
      legacyWhere({
        BoolExpr: {
          boolop: 0,
          args: [
            op('=', col('a'), { A_Const: { sval: 'x' } }),
            op('=', col('b'), { A_Const: { ival: 7 } }),
            op('=', col('c'), { A_Const: { boolval: true } }),
            op(
              '=',
              { ColumnRef: { fields: [{ str: 'd' }] } },
              { A_Const: { isnull: true } },
            ),
            op('=', { ColumnRef: { fields: [{ sval: 'e' }] } }, fn('auth.uid')),
            { NullTest: { arg: col('f'), nulltesttype: 0 } },
            { NullTest: { arg: col('g') } },
            { NullTest: { arg: col('h'), nulltesttype: 1 } },
            {
              BoolExpr: {
                boolop: 1,
                args: [
                  {
                    BoolExpr: {
                      boolop: 2,
                      args: [op('<>', col('i'), { A_Const: { ival: 1 } })],
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    expect((await condition('legacy')).mapped).toEqual({
      op: 'and',
      conditions: [
        { op: 'eq', field: 'a', value: 'x' },
        { op: 'eq', field: 'b', value: 7 },
        { op: 'eq', field: 'c', value: true },
        { op: 'eq', field: 'd', value: null },
        { op: 'eq', field: 'e', value: PRINCIPAL },
        { op: 'isNull', field: 'f', value: true },
        { op: 'isNull', field: 'g', value: true },
        { op: 'isNull', field: 'h', value: false },
        {
          op: 'or',
          conditions: [
            { op: 'not', condition: { op: 'ne', field: 'i', value: 1 } },
          ],
        },
      ],
    });
  });

  it('reads numeric sublink kinds and IN lists given as arrays', async () => {
    const memberships: RlsMemberships = {
      tenant: { table: 'org_members', user: 'u', role: 'r', tenant: 'org' },
    };
    nextParse(
      legacyWhere({
        BoolExpr: {
          boolop: 0,
          args: [
            {
              SubLink: {
                subLinkType: 0,
                subselect: select({ A_Const: { ival: 1 } }, 'org_members'),
              },
            },
            op('=', col('org'), [select(col('org'), 'org_members')]),
            {
              SubLink: {
                subLinkType: 2,
                testexpr: col('team_id'),
                subselect: select(
                  fn('permitted_team_ids', [{ A_Const: { sval: 'k' } }]),
                ),
              },
            },
            {
              SubLink: {
                subLinkType: 4,
                subselect: select(
                  fn('permdock_has', [{ A_Const: { sval: 'g' } }]),
                ),
              },
            },
            {
              SubLink: {
                subLinkType: 2,
                testexpr: col('team_id'),
                subselect: select(fn('member_team_ids')),
              },
            },
          ],
        },
      }),
    );
    expect((await condition('legacy', { memberships })).mapped).toEqual({
      op: 'and',
      conditions: [
        { op: 'memberOf', scope: 'tenant', field: 'org', roles: [] },
        { op: 'memberOf', scope: 'tenant', field: 'org', roles: [] },
        { op: 'memberOf', scope: 'team', field: 'team_id', roles: [] },
        {
          op: 'opaque',
          sql: "(select permdock_has('g'))",
          fingerprint: expect.any(String),
        },
        { op: 'memberOf', scope: 'team', field: 'team_id', roles: [] },
      ],
    });
  });

  it.each([
    ['a BoolExpr without args', { BoolExpr: { boolop: 0 } }],
    ['a not without args', { BoolExpr: { boolop: 2, args: [] } }],
    ['a scalar', 7],
    [
      'an operator without a name',
      { A_Expr: { lexpr: col('a'), rexpr: { A_Const: { ival: 1 } } } },
    ],
    [
      'a function name part that is not a string',
      op('=', col('a'), fn('x', [])),
    ],
    [
      'a sublink over a non-table relation',
      {
        SubLink: {
          subLinkType: 0,
          subselect: { SelectStmt: { fromClause: [{ RangeVar: {} }] } },
        },
      },
    ],
    [
      'an empty column reference',
      op('=', { ColumnRef: { fields: [] } }, { A_Const: { ival: 1 } }),
    ],
    [
      'a constant of an unknown kind',
      op('=', col('a'), { A_Const: { fval: '1.5' } }),
    ],
    [
      'a non-number ival',
      op('=', col('a'), { A_Const: { ival: { ival: '1' } } }),
    ],
    [
      'a non-boolean boolval',
      op('=', col('a'), { A_Const: { boolval: { boolval: 1 } } }),
    ],
  ])('keeps %s opaque', async (_label, where) => {
    nextParse(legacyWhere(where));
    expect((await condition('legacy')).mapped).toMatchObject({ op: 'opaque' });
  });

  it('reads a function name with an unreadable part as unmapped', async () => {
    nextParse(legacyWhere({ FuncCall: { funcname: [str('app'), 7] } }));
    expect((await condition('legacy')).unmapped).toEqual(['app.']);
  });

  it('reads seeds from RawStmt-wrapped inserts and skips malformed value lists', async () => {
    const row = (values: readonly string[]) => ({
      List: { items: values.map((value) => ({ A_Const: { sval: value } })) },
    });
    nextParse({
      stmts: [
        {
          RawStmt: {
            stmt: {
              InsertStmt: {
                relation: { relname: 'role_permissions' },
                cols: ['role', 'permission', 'grant_key', 'scope'].map(
                  (name) => ({
                    ResTarget: { name },
                  }),
                ),
                selectStmt: {
                  SelectStmt: {
                    valuesLists: [
                      row(['r', 'p', 'p', 'team']),
                      { List: {} },
                      3,
                    ],
                  },
                },
              },
            },
          },
        },
      ],
    });
    expect(await seedsFromSql('legacy')).toEqual([
      {
        role: 'r',
        permission: 'p',
        grantKey: 'p',
        scope: 'team',
        effect: 'allow',
      },
    ]);
    nextParse({ unexpected: true });
    expect(await seedsFromSql('legacy')).toEqual([]);
  });
});
