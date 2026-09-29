import { run } from 'permdock/cli';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rlsParity } from 'permdock/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import { permissions } from '../fixtures/posts/permissions.ts';
import { policy } from '../fixtures/posts/policy.ts';
import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/posts');
const own = { id: 'p1', authorId: 'u1' };
const other = { id: 'p2', authorId: 'u9' };
const slug = { id: 'p3', authorId: 'user-2' };
const publicJob = { id: 'j-public', scope: 'public', teamId: null };
const teamJob = { id: 'j-team', scope: 'team', teamId: 't1' };
const foreignJob = { id: 'j-other', scope: 'team', teamId: 't9' };

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
grant usage on schema public to authenticated, anon;
create table post (
  id text primary key,
  "authorId" text not null
);
alter table post enable row level security;
alter table post force row level security;
insert into post (id, "authorId") values ('p1', 'u1'), ('p2', 'u9'), ('p3', 'user-2');
create table team_users (
  team_id text not null,
  user_id text not null
);
insert into team_users (team_id, user_id) values ('t1', 'u1');
create table job (
  id text primary key,
  scope text not null,
  "teamId" text
);
alter table job enable row level security;
alter table job force row level security;
insert into job (id, scope, "teamId") values
  ('j-public', 'public', null),
  ('j-team', 'team', 't1'),
  ('j-other', 'team', 't9');
create or replace function job_permitted(job_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  rec record;
begin
  select scope, "teamId" into rec from job where id = job_id;
  if not found then
    return false;
  end if;
  if rec.scope = 'public' then
    return true;
  end if;
  if rec.scope = 'team' then
    return exists (
      select 1 from team_users tu
      where tu.team_id = rec."teamId"
        and tu.user_id = current_setting('app.user_id', true)
    );
  end if;
  return false;
end;
$$;
grant execute on function job_permitted(text) to authenticated, tester;
`;

describe('RLS parity', () => {
  let db: Postgres | undefined;
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
    db = await startPostgres([SETUP, generated]);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('never emits service_role in generated SQL', () => {
    expect(generateCode).toBe(0);
    expect(generated).not.toMatch(/service_role/i);
    expect(generated).toContain('current_setting');
    expect(generated).toContain('enable row level security');
    expect(generated).toContain('"job_permitted"("id")');
  });

  it('agrees with can() for granted reads and filtered updates', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const client = db.tester;
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
        {
          name: 'update slug owner as 2',
          subject: { id: '2', roles: ['member'] },
          permission: permissions.post.update,
          row: slug,
          table: 'post',
        },
        {
          name: 'update slug owner as user-2',
          subject: { id: 'user-2', roles: ['member'] },
          permission: permissions.post.update,
          row: slug,
          table: 'post',
        },
        {
          name: 'job public',
          subject: { id: 'u1', roles: ['member'] },
          permission: permissions.job.read,
          row: publicJob,
          table: 'job',
        },
        {
          name: 'job team',
          subject: {
            id: 'u1',
            roles: ['member'],
            memberships: [{ team: 't1', roles: ['member'] }],
          },
          permission: permissions.job.read,
          row: teamJob,
          table: 'job',
        },
        {
          name: 'job foreign',
          subject: {
            id: 'u1',
            roles: ['member'],
            memberships: [{ team: 't1', roles: ['member'] }],
          },
          permission: permissions.job.read,
          row: foreignJob,
          table: 'job',
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
      {
        name: 'update slug owner as 2',
        granted: false,
        database: 'filtered',
        ok: true,
      },
      {
        name: 'update slug owner as user-2',
        granted: true,
        database: 'allowed',
        ok: true,
      },
      { name: 'job public', granted: true, database: 'allowed', ok: true },
      { name: 'job team', granted: true, database: 'allowed', ok: true },
      { name: 'job foreign', granted: false, database: 'filtered', ok: true },
    ]);
  });
});
