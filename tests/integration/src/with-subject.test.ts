import { PrismaPg } from '@prisma/adapter-pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Kysely, PostgresDialect } from 'kysely';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPermDock, type PermDock } from 'permdock';
import { run } from 'permdock/cli';
import { withSubject as drizzleWithSubject } from 'permdock/drizzle';
import { withSubject as kyselyWithSubject } from 'permdock/kysely';
import { withSubject as prismaWithSubject } from 'permdock/prisma';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import {
  graphPolicy,
  permissions,
  relations,
  rows,
  schemaSql,
  seedSql,
  users,
} from '../fixtures/workspace/policy.ts';
import { startPostgres } from './support/postgres.ts';
import { PrismaClient } from './support/prisma/client.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/workspace');

const ROLES = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
grant usage on schema public to authenticated, anon;
`;

const TABLES = ['doc', 'folder', 'team'] as const;
type Table = (typeof TABLES)[number];

const reads = {
  doc: permissions.doc.read,
  folder: permissions.folder.read,
  team: permissions.team.read,
} as const;

type Reader = (dock: PermDock, table: Table) => Promise<string[]>;

async function dockFor(sub: string): Promise<PermDock> {
  return createPermDock(graphPolicy, { id: sub }, { relations });
}

async function inProcess(dock: PermDock, table: Table): Promise<string[]> {
  await dock.loadRelations(reads[table], rows[table]);
  // SAFETY: rows[table] holds the seeded rows for the resource reads[table] checks
  return rows[table]
    .filter((row) => dock.can(reads[table], row as never))
    .map((row) => row.id)
    .toSorted();
}

type PrismaRawTx = {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

type PrismaDb = {
  $transaction<T>(fn: (tx: PrismaRawTx) => Promise<T>): Promise<T>;
  $disconnect(): Promise<void>;
};

function testerUri(uri: string): string {
  const url = new URL(uri);
  url.username = 'tester';
  url.password = 'tester';
  return url.toString();
}

describe('withSubject runs Drizzle, Kysely and Prisma under the generated RLS', () => {
  let db: Postgres | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaDb | undefined;
  let kysely: Kysely<Record<Table, { id: string }>> | undefined;
  const dir = mkdtempSync(join(tmpdir(), 'permdock-with-subject-'));

  beforeAll(async () => {
    const out = join(dir, 'workspace.sql');
    const generated = await run(
      ['rls', 'generate', '--target', 'sql', '--out', out],
      {
        cwd: FIXTURE,
      },
    );
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    db = await startPostgres([
      ROLES,
      schemaSql,
      readFileSync(out, 'utf8'),
      seedSql,
    ]);
    const uri = testerUri(db.uri);
    pool = new Pool({ connectionString: uri });
    kysely = new Kysely({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: uri }),
      }),
    });
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: uri }),
    });
  }, 180_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await prisma?.$disconnect();
    await kysely?.destroy();
    await pool?.end();
    await db?.stop();
  });

  const readers: Record<string, Reader> = {
    drizzle: async (dock, table) => {
      if (pool === undefined) {
        throw new Error('PermDock: Postgres was not started');
      }
      const orm = drizzle({ client: pool });
      return drizzleWithSubject(
        orm,
        dock,
        async (tx) =>
          (
            await tx.execute<{ id: string }>(
              sql.raw(`select id from public.${table} order by id`),
            )
          ).rows.map((row) => row.id),
        { dialect: 'guc' },
      );
    },
    kysely: async (dock, table) => {
      if (kysely === undefined) {
        throw new Error('PermDock: Postgres was not started');
      }
      return kyselyWithSubject(
        kysely,
        dock,
        async (trx) =>
          (
            await trx.selectFrom(table).select('id').orderBy('id').execute()
          ).map((row) => row.id),
        { dialect: 'guc' },
      );
    },
    prisma: async (dock, table) => {
      if (prisma === undefined) {
        throw new Error('PermDock: Postgres was not started');
      }
      return prismaWithSubject(
        prisma,
        dock,
        async (tx) =>
          (
            await tx.$queryRawUnsafe<{ id: string }[]>(
              `select id from public.${table} order by id`,
            )
          ).map((row) => row.id),
        { dialect: 'guc' },
      );
    },
  };

  for (const [name, read] of Object.entries(readers)) {
    it(`${name}: each subject sees exactly the rows can() allows`, async () => {
      const mismatches: string[] = [];
      for (const user of users.filter(
        (item) => item.memberships === undefined,
      )) {
        for (const table of TABLES) {
          const dock = await dockFor(user.id);
          const got = await read(dock, table);
          const want = await inProcess(dock, table);
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            mismatches.push(
              `${user.id} ${table}: rls [${got.join(',')}] can [${want.join(',')}]`,
            );
          }
        }
      }
      expect(mismatches).toEqual([]);
      expect(await read(await dockFor('lena'), 'doc')).toEqual(['deep-doc']);
    });
  }
});
