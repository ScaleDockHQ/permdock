import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  allow,
  anyone,
  definePermissions,
  definePolicy,
  principal,
  resource,
  relation,
  role,
} from '../../src/index.ts';
import { rlsParity } from '../../src/testing/rls-parity.ts';

const Post = z.object({
  id: z.string(),
  authorId: z.string(),
});

const permissions = definePermissions({
  post: resource(Post, {
    id: 'id',
    actions: ['read', 'update', 'publish', 'delete'],
    collection: ['list', 'create'],
  }),
});

const policy = definePolicy(permissions, {
  roles: [
    role('member', [
      allow(permissions.post.read),
      allow(permissions.post.list),
      allow(permissions.post.create),
      allow(permissions.post.update, { where: { authorId: principal.id } }),
      allow(permissions.post.publish, { where: { authorId: principal.id } }),
      allow(permissions.post.delete, { where: { authorId: principal.id } }),
    ]),
  ],
  subject: (user: { readonly id: string; readonly roles: readonly string[] }) =>
    user,
});

const own = { id: 'p1', authorId: 'u1' };
const other = { id: 'p2', authorId: 'u9' };

describe('rlsParity', () => {
  it('agrees when the database filters a denied update', async () => {
    const report = await rlsParity(policy, {
      dialect: 'guc',
      fixtures: [
        {
          name: 'read own',
          subject: { id: 'u1', roles: ['member'] },
          permission: permissions.post.read,
          row: own,
          table: 'post',
        },
        {
          name: 'update other',
          subject: { id: 'u1', roles: ['member'] },
          permission: permissions.post.update,
          row: other,
          table: 'post',
        },
      ],
      query: async (sql, values) => {
        expect(sql).not.toMatch(/service_role/i);
        if (sql.startsWith('update') && values?.[0] === 'p2') {
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith('select *') && values?.[0] === 'p1') {
          return { rows: [own], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    });
    expect(report.ok).toBe(true);
    expect(report.results).toEqual([
      { name: 'read own', granted: true, database: 'allowed', ok: true },
      { name: 'update other', granted: false, database: 'filtered', ok: true },
    ]);
  });

  it('treats 42501 as rejected and never uses service_role', async () => {
    const report = await rlsParity(policy, {
      fixtures: [
        {
          name: 'update other rejected',
          subject: { id: 'u1', roles: ['member'] },
          permission: permissions.post.update,
          row: other,
          table: 'post',
        },
      ],
      query: async (sql) => {
        expect(sql).not.toMatch(/service_role/i);
        if (sql.startsWith('update')) {
          return { rows: [], code: '42501' };
        }
        return { rows: [] };
      },
    });
    expect(report.results[0]?.database).toBe('rejected');
    expect(report.ok).toBe(true);
  });

  it('sets supabase jwt claims and guc tenant settings', async () => {
    const seen: string[] = [];
    await rlsParity(policy, {
      dialect: 'supabase',
      fixtures: [
        {
          name: 'list own',
          subject: {
            id: 'u1',
            roles: ['member'],
            tenant: 'o1',
            memberships: [{ tenant: 'o1', roles: ['member'] }],
          },
          permission: permissions.post.list,
          row: own,
          table: 'post',
        },
      ],
      query: async (sql, values) => {
        seen.push(`${sql} ${String(values?.[0] ?? '')}`);
        if (values?.[0] === 'request.jwt.claims') {
          expect(String(values[1])).toContain('"sub":"u1"');
        }
        if (sql.startsWith('select *')) {
          return { rows: [own], rowCount: 1 };
        }
        return { rows: [] };
      },
    });
    expect(seen.some((sql) => sql.includes('request.jwt.claims'))).toBe(true);

    const guc: string[] = [];
    await rlsParity(policy, {
      dialect: 'guc',
      fixtures: [
        {
          name: 'read with tenant',
          subject: { id: 'u1', roles: ['member'], tenant: 'o1' },
          permission: permissions.post.read,
          row: own,
          table: 'post',
        },
      ],
      query: async (sql, values) => {
        guc.push(`${sql} ${String(values?.[0] ?? '')}`);
        if (sql.startsWith('select *')) {
          return { rows: [own], rowCount: 1 };
        }
        return { rows: [] };
      },
    });
    expect(guc.some((sql) => sql.includes('app.user_id'))).toBe(true);
    expect(guc.some((sql) => sql.includes('app.tenant_id'))).toBe(true);
  });

  it('compiles create, delete and unknown actions and rejects unsafe tables', async () => {
    const sqls: string[] = [];
    await rlsParity(policy, {
      fixtures: [
        {
          name: 'create',
          subject: { id: 'u1', roles: ['member'] },
          permission: permissions.post.create,
          row: own,
          table: 'post',
        },
        {
          name: 'delete',
          subject: { id: 'u1', roles: ['member'] },
          permission: permissions.post.delete,
          row: own,
          table: 'post',
        },
        {
          name: 'publish',
          subject: { id: 'u1', roles: ['member'] },
          permission: permissions.post.publish,
          row: own,
          table: 'post',
        },
      ],
      query: async (sql) => {
        sqls.push(sql);
        return { rows: [own], rowCount: 1 };
      },
    });
    expect(sqls.some((sql) => sql.startsWith('insert'))).toBe(true);
    expect(sqls.some((sql) => sql.startsWith('delete'))).toBe(true);
    expect(sqls.some((sql) => sql.startsWith('select *'))).toBe(true);

    await expect(
      rlsParity(policy, {
        fixtures: [
          {
            name: 'unsafe',
            subject: { id: 'u1', roles: ['member'] },
            permission: permissions.post.read,
            row: own,
            table: 'post;drop',
          },
        ],
        query: async () => ({ rows: [] }),
      }),
    ).rejects.toThrow(/unsafe SQL identifier/);
  });

  it('reports mismatch when the database filters a granted read', async () => {
    const report = await rlsParity(policy, {
      fixtures: [
        {
          name: 'read own missing',
          subject: { id: 'u1', roles: ['member'] },
          permission: permissions.post.read,
          row: own,
          table: 'post',
        },
      ],
      query: async () => ({ rows: [], rowCount: 0 }),
    });
    expect(report.ok).toBe(false);
    expect(report.results[0]).toMatchObject({
      granted: true,
      database: 'filtered',
      ok: false,
    });
  });
});

const relationPermissions = definePermissions({
  post: resource(Post, {
    id: 'id',
    actions: ['read', 'update'],
    collection: ['list'],
    relations: { author: 'authorId' },
  }),
});

const relationPolicy = definePolicy(relationPermissions, {
  principal: (user: {
    readonly id: string;
    readonly roles: readonly string[];
  }) => user,
  grants: [
    allow(relationPermissions.post.read, { to: anyone() }),
    allow(relationPermissions.post.update, {
      to: relation(relationPermissions.post, 'author'),
    }),
  ],
});

describe('rlsParity relation grantee', () => {
  it('agrees when a relation where filters another author', async () => {
    const report = await rlsParity(relationPolicy, {
      dialect: 'guc',
      fixtures: [
        {
          name: 'update own',
          subject: { id: 'u1', roles: ['member'] },
          permission: relationPermissions.post.update,
          row: own,
          table: 'post',
        },
        {
          name: 'update other',
          subject: { id: 'u1', roles: ['member'] },
          permission: relationPermissions.post.update,
          row: other,
          table: 'post',
        },
      ],
      query: async (sql, values) => {
        expect(sql).not.toMatch(/service_role/i);
        if (sql.startsWith('update') && values?.[0] === 'p2') {
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith('update') && values?.[0] === 'p1') {
          return { rows: [own], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    });
    expect(report.ok).toBe(true);
    expect(report.results).toEqual([
      { name: 'update own', granted: true, database: 'allowed', ok: true },
      { name: 'update other', granted: false, database: 'filtered', ok: true },
    ]);
  });

  it('also decides from the serialized snapshot and flags a disagreement', async () => {
    const report = await rlsParity(policy, {
      dialect: 'supabase',
      snapshot: true,
      fixtures: [
        {
          name: 'read own',
          subject: {
            id: 'u1',
            roles: ['member'],
            tenant: 'o1',
            memberships: [{ tenant: 'o1', roles: ['member'] }],
          },
          permission: permissions.post.read,
          row: own,
          table: 'post',
        },
      ],
      query: async (sql, values) => {
        if (sql.startsWith('select set_config')) {
          const claims = JSON.parse(String(values?.[1])) as {
            readonly memberships: readonly unknown[];
          };
          expect(claims.memberships).toEqual([
            { scope: 'tenant', id: 'o1', roles: ['member'] },
          ]);
        }
        return sql.startsWith('select *')
          ? { rows: [own], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
    });
    expect(report.results).toEqual([
      {
        name: 'read own',
        granted: true,
        database: 'allowed',
        snapshot: true,
        ok: true,
      },
    ]);
  });
});

const Invoice = z.object({
  id: z.string(),
  title: z.string(),
  amount: z.number(),
});

const invoices = definePermissions({
  invoice: resource(Invoice, {
    id: 'id',
    actions: ['read', 'update'],
    collection: ['list'],
  }),
});

const fieldPolicy = definePolicy(invoices, {
  roles: [
    role('admin', [allow([invoices.invoice.read, invoices.invoice.update])]),
    role('finance', [
      allow(invoices.invoice.read, { fields: ['id', 'title'] }),
    ]),
  ],
  subject: (user: { readonly id: string; readonly roles: readonly string[] }) =>
    user,
});

const invoice = { id: 'i1', title: 'Rent', amount: 100 };

type Answer = {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount?: number;
  readonly code?: string;
};

function fieldDb(view: (sql: string) => Answer): {
  readonly sqls: string[];
  readonly query: (sql: string) => Promise<Answer>;
} {
  const sqls: string[] = [];
  return {
    sqls,
    query: async (sql) => {
      sqls.push(sql);
      if (sql.includes('"invoice_visible"')) {
        return view(sql);
      }
      if (sql.startsWith('select * from "invoice"')) {
        return { rows: [invoice], rowCount: 1 };
      }
      if (sql.startsWith('select "id" from "invoice"')) {
        return { rows: [{ id: 'i1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

describe('rlsParity fieldViews', () => {
  it('compares the view row with the columns pick keeps', async () => {
    const db = fieldDb(() => ({
      rows: [{ id: 'i1', title: 'Rent', amount: null }],
      rowCount: 1,
    }));
    const report = await rlsParity(fieldPolicy, {
      dialect: 'neon',
      fieldViews: true,
      fixtures: [
        {
          name: 'finance',
          subject: { id: 'u1', roles: ['finance'] },
          permission: invoices.invoice.read,
          row: invoice,
          table: 'invoice',
        },
        {
          name: 'admin sees a masked amount',
          subject: { id: 'u2', roles: ['admin'] },
          permission: invoices.invoice.read,
          row: invoice,
          table: 'invoice',
        },
      ],
      query: db.query,
    });
    expect(report.results).toEqual([
      {
        name: 'finance',
        granted: true,
        database: 'allowed',
        fields: { app: ['id', 'title'], database: ['id', 'title'] },
        ok: true,
      },
      {
        name: 'admin sees a masked amount',
        granted: true,
        database: 'allowed',
        fields: { app: ['amount', 'id', 'title'], database: ['id', 'title'] },
        ok: false,
      },
    ]);
    expect(db.sqls).toContain('select "id" from "invoice" where "id" = $1');
    expect(
      db.sqls.some(
        (sql) =>
          sql.includes('request.jwt.claims') ||
          sql.startsWith('select set_config'),
      ),
    ).toBe(true);
  });

  it('reads the table when it has no view, and reports a failed view read', async () => {
    const missing = fieldDb(() => ({ rows: [], code: '42P01' }));
    const admin = {
      name: 'admin',
      subject: { id: 'u2', roles: ['admin'] },
      permission: invoices.invoice.read,
      row: invoice,
      table: 'invoice',
    };
    const fallback = await rlsParity(fieldPolicy, {
      fieldViews: true,
      fixtures: [admin],
      query: missing.query,
    });
    expect(fallback.results[0]?.fields).toEqual({
      app: ['amount', 'id', 'title'],
      database: ['amount', 'id', 'title'],
    });
    expect(fallback.ok).toBe(true);
    expect(missing.sqls).toContain('rollback to savepoint permdock_fields');
    const refused = await rlsParity(fieldPolicy, {
      fieldViews: true,
      fixtures: [admin],
      query: fieldDb(() => ({ rows: [], code: '42501' })).query,
    });
    expect(refused.results[0]?.fields?.database).toBe('42501');
    expect(refused.ok).toBe(false);
  });

  it('expects no columns for a denied row and skips writes', async () => {
    const db = fieldDb(() => ({ rows: [], rowCount: 0 }));
    const report = await rlsParity(fieldPolicy, {
      fieldViews: true,
      fixtures: [
        {
          name: 'stranger',
          subject: { id: 'u3', roles: [] },
          permission: invoices.invoice.read,
          row: invoice,
          table: 'invoice',
        },
        {
          name: 'finance update',
          subject: { id: 'u1', roles: ['finance'] },
          permission: invoices.invoice.update,
          row: invoice,
          table: 'invoice',
        },
      ],
      query: async (sql) =>
        sql.startsWith('select "id"')
          ? { rows: [], rowCount: 0 }
          : db.query(sql),
    });
    expect(report.results[0]?.fields).toEqual({ app: [], database: [] });
    expect(report.results[1]?.fields).toBeUndefined();
    expect(report.ok).toBe(true);
    expect(db.sqls).toContain(
      'update "invoice" set "id" = "id" where "id" = $1 returning "id"',
    );
  });
});
