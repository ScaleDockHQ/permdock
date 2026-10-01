import { describe, expect, it } from 'vitest';

import type { RolePermission } from '../../src/cli/rls-helpers.ts';

import {
  fieldViewsFromSql,
  viewsSqlFromDb,
} from '../../src/cli/rls-import-views.ts';

const seeds: RolePermission[] = [
  {
    role: 'admin',
    permission: 'invoice.read',
    grantKey: 'invoice.read#1',
    scope: 'global',
    effect: 'allow',
  },
  {
    role: 'auditor',
    permission: 'invoice.read',
    grantKey: 'invoice.read#2',
    scope: 'global',
    effect: 'deny',
  },
];

const ADMIN = {
  key: 'invoice.read#1',
  permission: 'invoice.read',
  scope: 'global',
  roles: ['admin'],
};
const AUDITOR = {
  key: 'invoice.read#2',
  permission: 'invoice.read',
  scope: 'global',
  roles: ['auditor'],
};

async function views(sql: string): Promise<unknown> {
  return fieldViewsFromSql(sql, undefined, undefined, seeds);
}

describe('fieldViewsFromSql masks', () => {
  it('reads an allow, a lone deny and an allow with a trailing deny', async () => {
    expect(
      await views(`create view invoice_visible with (security_invoker) as
select i.id,
  case when (select permdock_has('invoice.read#1')) then i.amount end as amount,
  case when not (select permdock_has('invoice.read#2')) then i.note end,
  case when (select permdock_has('invoice.read#1')) and "a" = 1 and not (select permdock_has('invoice.read#2')) then i.secret end as secret,
  case when (select permdock_has('invoice.read#1')) and "a" = 1 then i.code end as code
from invoice i;`),
    ).toEqual([
      {
        view: 'invoice_visible',
        table: 'invoice',
        passthrough: ['id'],
        restricted: [
          { column: 'amount', grants: [ADMIN], denies: [] },
          { column: 'note', grants: [], denies: [AUDITOR] },
          {
            column: 'secret',
            grants: [{ ...ADMIN, where: { op: 'eq', field: 'a', value: 1 } }],
            denies: [AUDITOR],
          },
          {
            column: 'code',
            grants: [{ ...ADMIN, where: { op: 'eq', field: 'a', value: 1 } }],
            denies: [],
          },
        ],
      },
    ]);
  });
});

describe('fieldViewsFromSql shapes it skips', () => {
  it.each([
    [
      'a view that is not security_invoker',
      `create view invoice_visible with (security_invoker = false) as select id from invoice;`,
    ],
    [
      'a view without the _visible suffix',
      `create view invoice_view with (security_invoker = on) as select id from invoice;`,
    ],
    [
      'a star target',
      `create view invoice_visible with (security_invoker) as select i.* from invoice i;`,
    ],
    [
      'a case that does not return a column',
      `create view invoice_visible with (security_invoker) as select case when true then 1 end as one from invoice;`,
    ],
    [
      'an expression target',
      `create view invoice_visible with (security_invoker) as select lower(name) as name from invoice;`,
    ],
    [
      'two from items',
      `create view invoice_visible with (security_invoker) as select a.id from invoice a, other b;`,
    ],
    [
      'an inner join',
      `create view invoice_visible with (security_invoker) as select t.id from invoice t join invoice_visible_fields f on f.permdock_key = t.id;`,
    ],
    [
      'a missing companion',
      `create view invoice_visible with (security_invoker) as select t.id, f.note from invoice t left join invoice_visible_fields f on f.permdock_key = t.id;`,
    ],
    [
      'a companion without security_barrier',
      `create view invoice_visible_fields as select id as permdock_key from invoice;
create view invoice_visible with (security_invoker) as select t.id from invoice t left join invoice_visible_fields f on f.permdock_key = t.id;`,
    ],
    ['SQL that does not parse', `create view (`],
  ])('skips %s', async (_label, sql) => {
    expect(await views(sql)).toEqual([]);
  });
});

describe('fieldViewsFromSql companions', () => {
  it('reads masks from the companion and keeps base columns as passthrough', async () => {
    expect(
      await views(`create table invoice (id uuid);
create view invoice_visible_fields with (security_barrier = 1) as
select id as permdock_key, case when (select permdock_has('invoice.read#1')) then amount end as amount, note
from invoice;
create view invoice_visible with (security_invoker = true) as
select title, t.id, invoice_visible_fields.amount, invoice_visible_fields.note
from invoice t left join invoice_visible_fields on invoice_visible_fields.permdock_key = t.id;`),
    ).toEqual([
      {
        view: 'invoice_visible',
        table: 'invoice',
        companion: 'invoice_visible_fields',
        passthrough: ['title', 'id'],
        restricted: [{ column: 'amount', grants: [ADMIN], denies: [] }],
      },
    ]);
  });

  it('keeps an unaliased base table in a companion join', async () => {
    const [view] =
      (await fieldViewsFromSql(
        `create view invoice_visible_fields with (security_barrier) as select id as permdock_key from invoice;
create view invoice_visible with (security_invoker) as select invoice.id from invoice left join invoice_visible_fields f on f.permdock_key = invoice.id;`,
        undefined,
        undefined,
        [],
      )) ?? [];
    expect(view).toEqual({
      view: 'invoice_visible',
      table: 'invoice',
      companion: 'invoice_visible_fields',
      passthrough: ['id'],
      restricted: [],
    });
  });
});

describe('viewsSqlFromDb', () => {
  it('rebuilds create view statements with only safe options', async () => {
    const sql: string[] = [];
    const text = await viewsSqlFromDb(async (statement) => {
      sql.push(statement);
      return {
        rows: [
          {
            schema: 'public',
            name: 'invoice_visible',
            options: ['security_invoker=true', 'bad option', 3],
            definition: ' SELECT id FROM invoice; ',
          },
          {
            schema: 'app',
            name: 'odd"name',
            options: null,
            definition: 'SELECT 1',
          },
          { schema: 'public', name: 'broken', definition: null },
        ],
      };
    });
    expect(sql).toHaveLength(1);
    expect(text).toBe(
      [
        'create view "public"."invoice_visible" with (security_invoker=true) as SELECT id FROM invoice;',
        'create view "app"."odd""name" as SELECT 1;',
      ].join('\n'),
    );
  });
});
