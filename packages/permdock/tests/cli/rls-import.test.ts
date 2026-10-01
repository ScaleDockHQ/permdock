import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { PermDockConfig } from '../../src/cli/types.ts';
import type { SqlCall, SqlReply } from '../fakes/sql.ts';

import { runRlsImport } from '../../src/cli/rls-import.ts';
import { fakeSql } from '../fakes/sql.ts';

const TMP = path.join(import.meta.dirname, '../../tmp');
mkdirSync(TMP, { recursive: true });
const root = mkdtempSync(path.join(TMP, 'rls-import-'));
const io = { stdout: () => undefined, stderr: () => undefined };
const config: PermDockConfig = { policy: './policy.ts' };

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let counter = 0;
function project(files: Readonly<Record<string, string>> = {}): string {
  counter += 1;
  const cwd = path.join(root, String(counter));
  mkdirSync(cwd, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(cwd, name), text);
  }
  return cwd;
}

type CatalogEntry = {
  readonly table: string;
  readonly cmd: string;
  readonly permissive: boolean;
  readonly roles: readonly string[];
  readonly condition: unknown;
  readonly sourceSql: string;
  readonly grants?: readonly unknown[];
};

function catalogOf(
  cwd: string,
  out = 'src/permissions.generated.ts',
): readonly CatalogEntry[] {
  const text = readFileSync(path.join(cwd, out), 'utf8');
  const json = /export const catalog = ([\s\S]*?) as const/u.exec(text)?.[1];
  // SAFETY: the catalog JSON literal rls import wrote into the module above.
  return JSON.parse(json ?? 'null') as readonly CatalogEntry[];
}

describe('runRlsImport inputs', () => {
  it('needs --sql or --db', async () => {
    expect(
      await runRlsImport({ cwd: project(), config, schema: 'zod', io }),
    ).toEqual({
      code: 2,
      output: 'PermDock CLI: rls import needs --sql <file> or --db <url>',
    });
  });

  it('reports a missing SQL dump', async () => {
    expect(
      await runRlsImport({
        cwd: project(),
        config,
        sql: 'missing.sql',
        schema: 'zod',
        io,
      }),
    ).toEqual({
      code: 2,
      output: 'PermDock CLI: SQL dump not found: missing.sql',
    });
  });

  it('refuses SQL that targets service_role', async () => {
    const cwd = project({
      'dump.sql':
        'create policy p on posts for select to service_role using (true);',
    });
    await expect(
      runRlsImport({ cwd, config, sql: 'dump.sql', schema: 'zod', io }),
    ).rejects.toThrow('imported SQL must never target service_role');
  });
});

describe('runRlsImport --sql', () => {
  it('reads commands, restrictive policies, default roles and with check', async () => {
    const cwd = project({
      'dump.sql': `
create policy posts_all on posts as restrictive to anon, authenticated using ("published" = true);
create policy posts_insert on posts for insert with check ("authorId" = (select auth.uid()));
create policy notes_delete on notes for delete using (true);
`,
    });
    const result = await runRlsImport({
      cwd,
      config,
      sql: 'dump.sql',
      schema: 'not-a-schema',
      io,
    });
    expect(result).toEqual({
      code: 0,
      output: 'wrote src/permissions.generated.ts',
    });
    const catalog = catalogOf(cwd);
    expect(
      catalog.map((entry) => [
        entry.table,
        entry.cmd,
        entry.permissive,
        entry.roles,
      ]),
    ).toEqual([
      ['posts', 'SELECT', false, ['anon', 'authenticated']],
      ['posts', 'INSERT', false, ['anon', 'authenticated']],
      ['posts', 'UPDATE', false, ['anon', 'authenticated']],
      ['posts', 'DELETE', false, ['anon', 'authenticated']],
      ['posts', 'INSERT', true, ['PUBLIC']],
      ['notes', 'DELETE', true, ['PUBLIC']],
    ]);
    expect(catalog[4]?.condition).toEqual({
      op: 'eq',
      field: 'authorId',
      value: { ref: 'principal.id' },
    });
    const module = readFileSync(
      path.join(cwd, 'src/permissions.generated.ts'),
      'utf8',
    );
    expect(module).toContain("from 'zod'");
    expect(module).toMatch(/notes[\s\S]*actions: \["delete"\]/u);
  });

  it('falls back to the raw text when the dump does not parse, and reads a create-only table', async () => {
    const cwd = project({
      'dump.sql': `create policy jobs_insert on jobs for insert to authenticated with check (true);
create policy jobs_read on jobs using (note = 'for delete to anon');
this is not sql;`,
    });
    const result = await runRlsImport({
      cwd,
      config,
      sql: 'dump.sql',
      out: 'gen.ts',
      schema: 'valibot',
      io,
    });
    expect(result.code).toBe(0);
    expect(
      catalogOf(cwd, 'gen.ts')
        .slice(0, 2)
        .map((entry) => [entry.table, entry.cmd, entry.roles]),
    ).toEqual([
      ['jobs', 'INSERT', ['authenticated']],
      ['jobs', 'SELECT', ['authenticated']],
    ]);
    const module = readFileSync(path.join(cwd, 'gen.ts'), 'utf8');
    expect(module).toContain("from 'valibot'");
  });

  it('reads a create-only table as read plus create', async () => {
    const cwd = project({
      'dump.sql':
        'create policy jobs_insert on jobs for insert with check (true);',
    });
    await runRlsImport({ cwd, config, sql: 'dump.sql', schema: 'zod', io });
    const module = readFileSync(
      path.join(cwd, 'src/permissions.generated.ts'),
      'utf8',
    );
    expect(module).toMatch(
      /jobs[\s\S]*actions: \["read"\],\s*collection: \["create"\]/u,
    );
  });

  it('writes an empty catalog for a dump without policies', async () => {
    const cwd = project({ 'dump.sql': 'create table t (id int);' });
    expect(
      (await runRlsImport({ cwd, config, sql: 'dump.sql', schema: 'zod', io }))
        .code,
    ).toBe(0);
    expect(catalogOf(cwd)).toEqual([]);
  });

  it('hints at unmapped functions, unknown membership tables and field views', async () => {
    const cwd = project({
      'dump.sql': `create policy jobs_read on jobs for select using (app.job_permitted(id) and exists (select 1 from grants g where g.job = id));
create view jobs_visible with (security_invoker) as select id, case when (select permdock_has('jobs.read')) then secret end as secret from jobs;`,
    });
    const result = await runRlsImport({
      cwd,
      config: { policy: './policy.ts', rls: { memberships: {} } },
      sql: 'dump.sql',
      schema: 'zod',
      io,
    });
    expect(result.code).toBe(0);
    expect(result.output.split('\n')).toEqual([
      'wrote src/permissions.generated.ts',
      'add rls.functions.job_permitted to make this grant portable',
      'exists over grants stayed opaque; if it holds memberships, map it in permdock.config.ts:',
      "// rls: { memberships: { tenant: { table: 'grants', user: 'user_id', tenant: 'tenant_id', role: 'role' } } }",
      'field view jobs_visible over jobs: secret are field-limited; set fields on the read grants that list them (fieldViews export)',
    ]);
    expect(
      readFileSync(path.join(cwd, 'src/permissions.generated.ts'), 'utf8'),
    ).toContain('export const fieldViews');
  });

  it('reads --memberships before the config mapping', async () => {
    const cwd = project({
      'dump.sql': `create policy p on posts for select using ("orgId" in (select org_id from org_members));`,
    });
    await runRlsImport({
      cwd,
      config,
      sql: 'dump.sql',
      memberships: 'org_members:orgId,user_id,role',
      schema: 'zod',
      io,
    });
    expect(catalogOf(cwd)[0]?.condition).toEqual({
      op: 'memberOf',
      scope: 'tenant',
      field: 'orgId',
      roles: [],
    });
  });
});

const POLICY_ROWS = [
  {
    tablename: 'posts',
    policyname: 'posts_read',
    permissive: 'PERMISSIVE',
    roles: ['authenticated'],
    cmd: 'SELECT',
    qual: `("teamId" in (select permitted_team_ids('post.read')))`,
    with_check: null,
  },
  {
    tablename: 'posts',
    policyname: 'posts_guard',
    permissive: 'RESTRICTIVE',
    roles: '{anon,authenticated}',
    cmd: 'ALL',
    qual: null,
    with_check: 'app.fence(id)',
  },
  {
    tablename: 'posts',
    policyname: 'posts_odd',
    permissive: 'PERMISSIVE',
    roles: 7,
    cmd: null,
    qual: null,
    with_check: null,
  },
  { tablename: 7, policyname: 'ignored' },
];

function dbReply(options: {
  readonly schema?: unknown;
  readonly seedsFail?: boolean;
}): (call: SqlCall) => SqlReply | undefined {
  return (call) => {
    if (call.sql.includes('from pg_policies')) {
      return { rows: POLICY_ROWS };
    }
    if (call.sql.includes('from pg_proc')) {
      return {
        rows: [
          { proname: 'fence', prosrc: '  select true  ' },
          { proname: 7, prosrc: 'x' },
        ],
      };
    }
    if (call.sql.includes('information_schema.tables')) {
      return {
        rows:
          options.schema === undefined
            ? []
            : [{ table_schema: options.schema }],
      };
    }
    if (call.sql.includes('.role_permissions')) {
      return options.seedsFail === true
        ? { code: '42703' }
        : {
            rows: [
              {
                role: 'editor',
                permission: 'post.read',
                grant_key: 'post.read',
                scope: 'team',
                effect: 'allow',
              },
              { role: 'broken' },
            ],
          };
    }
    if (call.sql.includes('pg_get_viewdef')) {
      return { rows: [] };
    }
    return undefined;
  };
}

describe('runRlsImport --db through an injected client', () => {
  it('reads policies, function bodies and role_permissions seeds', async () => {
    const sql = fakeSql(dbReply({ schema: 'public' }));
    const cwd = project();
    const result = await runRlsImport({
      cwd,
      config,
      db: 'postgres://fake',
      schema: 'zod',
      io,
      connect: sql.connect,
    });
    expect(result.output.split('\n')).toEqual([
      'wrote src/permissions.generated.ts',
      'add rls.functions.fence to make this grant portable',
      '-- app.fence: select true',
    ]);
    expect(sql.ended()).toBe(true);
    expect(sql.statements()).toContain(
      'select role::text, permission::text, grant_key, scope, effect from "public".role_permissions',
    );
    const catalog = catalogOf(cwd);
    expect(
      catalog.map((entry) => [entry.cmd, entry.permissive, entry.roles]),
    ).toEqual([
      ['SELECT', true, ['authenticated']],
      ['SELECT', false, ['anon', 'authenticated']],
      ['INSERT', false, ['anon', 'authenticated']],
      ['UPDATE', false, ['anon', 'authenticated']],
      ['DELETE', false, ['anon', 'authenticated']],
      ['SELECT', true, []],
      ['INSERT', true, []],
      ['UPDATE', true, []],
      ['DELETE', true, []],
    ]);
    expect(catalog[0]?.grants).toEqual([
      {
        key: 'post.read',
        permission: 'post.read',
        scope: 'team',
        roles: ['editor'],
      },
    ]);
    expect(catalog[1]?.sourceSql).toBe('app.fence(id)');
    expect(catalog[5]?.condition).toEqual({
      op: 'eq',
      field: '_',
      value: true,
    });
  });

  it.each([
    ['no role_permissions table', { schema: undefined }],
    ['an unsafe schema name', { schema: 'bad schema' }],
    [
      'a role_permissions table without grant_key',
      { schema: 'public', seedsFail: true },
    ],
  ])('imports without seeds for %s', async (_label, options) => {
    const sql = fakeSql(dbReply(options));
    const cwd = project();
    const result = await runRlsImport({
      cwd,
      config,
      db: 'postgres://fake',
      schema: 'zod',
      io,
      connect: sql.connect,
    });
    expect(result.code).toBe(0);
    expect(catalogOf(cwd)[0]?.grants).toEqual([
      { key: 'post.read', permission: 'post.read', scope: 'team', roles: [] },
    ]);
  });

  it('answers 2 with the message when the database cannot be read', async () => {
    const result = await runRlsImport({
      cwd: project(),
      config,
      db: 'postgres://fake',
      schema: 'zod',
      io,
      connect: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    expect(result).toEqual({ code: 2, output: 'connect ECONNREFUSED' });
    const failing = await runRlsImport({
      cwd: project(),
      config,
      db: 'postgres://fake',
      schema: 'zod',
      io,
      connect: async () => {
        const down: unknown = 'down';
        throw down;
      },
    });
    expect(failing).toEqual({ code: 2, output: 'down' });
  });
});
