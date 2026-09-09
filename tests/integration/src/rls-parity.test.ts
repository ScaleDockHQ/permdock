import type { Policy } from 'permdock';

import { run } from '@permdock/cli';
import { rlsParity } from '@permdock/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { permissions } from '../fixtures/posts/permissions.ts';
import { policy } from '../fixtures/posts/policy.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/posts');
const own = { id: 'p1', authorId: 'u1' };
const other = { id: 'p2', authorId: 'u9' };

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role tester login password 'tester' nosuperuser nobypassrls inherit;
grant authenticated to tester;
grant usage on schema public to authenticated, anon, tester;
create table post (
  id text primary key,
  "authorId" text not null
);
alter table post enable row level security;
alter table post force row level security;
insert into post (id, "authorId") values ('p1', 'u1'), ('p2', 'u9');
`;

describe('RLS parity', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | undefined;
  let admin: Client | undefined;
  let tester: Client | undefined;
  let generated = '';
  let generateCode = 1;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'permdock-rls-'));
    const out = join(dir, 'rls.sql');
    const generate = await run(
      ['rls', 'generate', '--target', 'sql', '--dialect', 'guc', '--out', out],
      { cwd: FIXTURE },
    );
    generateCode = generate.code;
    generated = readFileSync(out, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    admin = new Client({ connectionString: container.getConnectionUri() });
    await admin.connect();
    await admin.query(SETUP);
    await admin.query(generated);
    tester = new Client({
      host: container.getHost(),
      port: container.getPort(),
      user: 'tester',
      password: 'tester',
      database: container.getDatabase(),
    });
    await tester.connect();
  }, 120_000);

  afterAll(async () => {
    if (tester !== undefined) {
      await tester.end();
    }
    if (admin !== undefined) {
      await admin.end();
    }
    if (container !== undefined) {
      await container.stop();
    }
  });

  it('never emits service_role in generated SQL', () => {
    expect(generateCode).toBe(0);
    expect(generated).not.toMatch(/service_role/i);
    expect(generated).toContain('current_setting');
    expect(generated).toContain('enable row level security');
  });

  it('agrees with can() for granted reads and filtered updates', async () => {
    if (tester === undefined) {
      throw new Error('PermDock: tester client was not started');
    }
    const client = tester;
    const report = await rlsParity(policy as Policy, {
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
          name: 'read other',
          subject: { id: 'u1', roles: ['member'] },
          permission: permissions.post.read,
          row: other,
          table: 'post',
        },
        {
          name: 'update own',
          subject: { id: 'u1', roles: ['member'] },
          permission: permissions.post.update,
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
        try {
          const result = await client.query(
            sql,
            values === undefined ? undefined : [...values],
          );
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        } catch (error) {
          const code =
            error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            typeof error.code === 'string'
              ? error.code
              : undefined;
          if (code === '42501') {
            return { rows: [], rowCount: 0, code };
          }
          throw error;
        }
      },
    });
    expect(report.ok).toBe(true);
    expect(report.results).toEqual([
      { name: 'read own', granted: true, database: 'allowed', ok: true },
      { name: 'read other', granted: true, database: 'allowed', ok: true },
      { name: 'update own', granted: true, database: 'allowed', ok: true },
      { name: 'update other', granted: false, database: 'filtered', ok: true },
    ]);
  });
});
