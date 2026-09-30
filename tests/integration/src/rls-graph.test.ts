import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPermDock, memoryRelations } from 'permdock';
import { run } from 'permdock/cli';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import { permissions } from '../fixtures/graph/permissions.ts';
import { policy } from '../fixtures/graph/policy.ts';
import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/graph');

const VERA = '00000000-0000-4000-8000-00000000000a';
const HANA = '00000000-0000-4000-8000-00000000000b';
const EDITH = '00000000-0000-4000-8000-00000000000c';

const f = (n: number): string =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const d = (n: number): string =>
  `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ROLES = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
`;

const STUB = `
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
create table public.folder (
  id uuid primary key,
  "parentId" uuid references public.folder (id),
  restricted boolean not null default false,
  "ownerId" uuid
);
create table public.doc (
  id uuid primary key,
  "folderId" uuid not null references public.folder (id),
  "ownerId" uuid,
  restricted boolean not null default false
);
create table public.folder_viewers (
  folder_id uuid not null references public.folder (id) on delete cascade,
  user_id uuid not null,
  expires_at timestamptz
);
create table public.folder_editors (
  folder_id uuid not null references public.folder (id) on delete cascade,
  user_id uuid not null
);
create table public.employee (
  id uuid primary key,
  "managerId" uuid references public.employee (id)
);
`;

// 1 ─ 2 ─ 3 ─ 4 ─ 5 ─ 6        (a chain past the viewer depth of 4)
//   └ 7 (restricted) ─ 8
const FOLDERS = [
  { id: f(1), parentId: null, restricted: false, ownerId: null },
  { id: f(2), parentId: f(1), restricted: false, ownerId: null },
  { id: f(3), parentId: f(2), restricted: false, ownerId: null },
  { id: f(4), parentId: f(3), restricted: false, ownerId: null },
  { id: f(5), parentId: f(4), restricted: false, ownerId: null },
  { id: f(6), parentId: f(5), restricted: false, ownerId: null },
  { id: f(7), parentId: f(1), restricted: true, ownerId: null },
  { id: f(8), parentId: f(7), restricted: false, ownerId: null },
];
const DOCS = FOLDERS.map((folder, index) => ({
  id: d(index + 1),
  folderId: folder.id,
  ownerId: null,
  restricted: false,
}));
const EDGES = [
  { folder_id: f(1), user_id: VERA },
  { folder_id: f(7), user_id: HANA },
];

function claims(sub: string): Readonly<Record<string, string>> {
  return {
    'request.jwt.claims': JSON.stringify({ sub, role: 'authenticated' }),
  };
}

async function seed(db: Postgres): Promise<void> {
  const values = (
    rows: readonly Record<string, string | boolean | null>[],
  ): string =>
    rows
      .map(
        (row) =>
          `(${Object.values(row)
            .map((value) =>
              value === null
                ? 'null'
                : typeof value === 'boolean'
                  ? String(value)
                  : `'${value}'`,
            )
            .join(', ')})`,
      )
      .join(', ');
  await db.admin.query(
    `insert into public.folder (id, "parentId", restricted, "ownerId") values ${values(FOLDERS)}`,
  );
  await db.admin.query(
    `insert into public.doc (id, "folderId", "ownerId", restricted) values ${values(DOCS)}`,
  );
  await db.admin.query(
    `insert into public.folder_viewers (folder_id, user_id) values ${values(EDGES)}`,
  );
  await db.admin.query(
    `insert into public.folder_editors (folder_id, user_id) values ('${f(2)}', '${EDITH}')`,
  );
}

async function visible(
  db: Postgres,
  sub: string,
  table: 'doc' | 'folder',
): Promise<readonly string[]> {
  return db.as({ role: 'authenticated', settings: claims(sub) }, async () => {
    const result = await db.tester.query<{ id: string }>(
      `select id::text from public.${table} order by id`,
    );
    return result.rows.map((row) => row.id);
  });
}

async function inProcess(
  sub: string,
  table: 'doc' | 'folder',
  folders: readonly Record<string, unknown>[],
): Promise<readonly string[]> {
  const relations = memoryRelations(permissions, {
    rows: { folder: folders },
    edges: {
      folder: {
        viewer: EDGES.map((edge) => ({
          id: edge.folder_id,
          principal: edge.user_id,
        })),
        editor: [{ id: f(2), principal: EDITH }],
      },
    },
  });
  const dock = await createPermDock(
    policy,
    { principal: { id: sub, roles: [] }, context: {} },
    { relations },
  );
  // SAFETY: folders holds the seeded folder rows permissions.folder.read checks
  return table === 'doc'
    ? DOCS.filter((row) => dock.can(permissions.doc.read, row)).map(
        (row) => row.id,
      )
    : folders
        .filter((row) => dock.can(permissions.folder.read, row as never))
        .map((row) => String(row['id']))
        .toSorted();
}

describe('relationship graph in RLS (closure table)', () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), 'permdock-graph-'));
  const out = join(dir, 'graph.sql');

  beforeAll(async () => {
    const generated = await run(
      ['rls', 'generate', '--target', 'sql', '--out', out],
      { cwd: FIXTURE },
    );
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}`);
    }
    db = await startPostgres([ROLES, STUB, readFileSync(out, 'utf8')]);
    await seed(db);
  }, 180_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  it('agrees with can() over ancestors, the depth cap and a restricted branch', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    for (const sub of [VERA, HANA, EDITH]) {
      for (const table of ['doc', 'folder'] as const) {
        expect(await visible(db, sub, table)).toEqual(
          await inProcess(sub, table, FOLDERS),
        );
      }
    }
    expect(await visible(db, VERA, 'folder')).toEqual(
      [f(1), f(2), f(3), f(4), f(5)].toSorted(),
    );
    expect(await visible(db, HANA, 'doc')).toEqual([d(7), d(8)]);
  });

  it('keeps the closure current when a branch moves or a folder turns restricted', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    await db.admin.query(
      `update public.folder set "parentId" = '${f(1)}' where id = '${f(5)}'`,
    );
    await db.admin.query(
      `update public.folder set restricted = true where id = '${f(3)}'`,
    );
    const folders = FOLDERS.map((row) =>
      Object.assign({}, row, {
        parentId: row.id === f(5) ? f(1) : row.parentId,
        restricted: row.id === f(3) ? true : row.restricted,
      }),
    );
    for (const sub of [VERA, HANA, EDITH]) {
      expect(await visible(db, sub, 'folder')).toEqual(
        await inProcess(sub, 'folder', folders),
      );
    }
    expect(await visible(db, VERA, 'folder')).toContain(f(6));
    expect(await visible(db, VERA, 'folder')).not.toContain(f(3));
    await db.admin.query(
      `update public.folder set restricted = false where id = '${f(3)}'`,
    );
    await db.admin.query(
      `update public.folder set "parentId" = '${f(4)}' where id = '${f(5)}'`,
    );
  });

  it('refuses a write that makes a folder its own ancestor', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    await expect(
      db.admin.query(
        `update public.folder set "parentId" = '${f(3)}' where id = '${f(1)}'`,
      ),
    ).rejects.toThrow(/its own ancestor/);
  });

  it('shows a subject only the closure rows under what it holds, one InitPlan per helper', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const rows = await db.as(
      { role: 'authenticated', settings: claims(HANA) },
      async () =>
        (
          await db!.tester.query<{ ancestor: string }>(
            'select distinct ancestor from public.permdock_closure',
          )
        ).rows.map((row) => row.ancestor),
    );
    expect(rows).toEqual([f(7)]);
    const plan = await db.as(
      { role: 'authenticated', settings: claims(VERA) },
      async () =>
        (
          await db!.tester.query<{ 'QUERY PLAN': string }>(
            'explain (analyze, costs off, timing off, summary off) select id from public.doc',
          )
        ).rows.map((row) => row['QUERY PLAN']),
    );
    expect(plan.join('\n')).toMatch(/InitPlan/);
    const helperScans = plan.filter((line) =>
      /ProjectSet|Function Scan/.test(line),
    );
    expect(helperScans.length).toBeGreaterThan(0);
    for (const line of helperScans) {
      expect(line).toMatch(/loops=1\)|never executed/);
    }
  });

  it('rls verify --tree agrees with decide on a generated tree with restricted branches', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const result = await run(['rls', 'verify', '--tree', '--db', db.uri], {
      cwd: FIXTURE,
    });
    const counts =
      /verified (\d+) tree check\(s\) against the database \((\d+) granted\)/u.exec(
        result.stdout,
      );
    expect(result.code).toBe(0);
    expect(Number(counts?.[1])).toBeGreaterThan(100);
    expect(Number(counts?.[2])).toBeGreaterThan(10);
  });
});
