import { run } from '@permdock/cli';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/supabase-rbac');

const ADMIN = '00000000-0000-4000-8000-00000000000a';
const MEMBER = '00000000-0000-4000-8000-00000000000b';
const STAFF = '00000000-0000-4000-8000-00000000000c';
const OUTSIDER = '00000000-0000-4000-8000-00000000000d';

// The parts of a Supabase database the scaffold relies on, without Supabase.
const SUPABASE_STUB = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
create role tester login password 'tester' nosuperuser nobypassrls inherit;
grant authenticated, anon, supabase_auth_admin to tester;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon, supabase_auth_admin;
grant execute on all functions in schema auth to authenticated, anon, supabase_auth_admin;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ('${ADMIN}'), ('${MEMBER}'), ('${STAFF}'), ('${OUTSIDER}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
alter table public.organization_members enable row level security;
create policy "members read their own rows" on public.organization_members
  for select to authenticated using (user_id = (select auth.uid()));
grant select on public.organization_members to authenticated;
insert into public.organization_members values
  ('acme', '${ADMIN}', 'admin'),
  ('acme', '${MEMBER}', 'member'),
  ('globex', '${OUTSIDER}', 'admin');
create table public.post (
  id text primary key,
  "orgId" text not null,
  "authorId" uuid not null
);
insert into public.post values
  ('a1', 'acme', '${MEMBER}'),
  ('a2', 'acme', '${ADMIN}'),
  ('g1', 'globex', '${OUTSIDER}');
`;

async function ids(client: Client): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    'select id from public.post order by id',
  );
  return result.rows.map((row) => row.id);
}

describe('Supabase RBAC scaffold, database mode', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | undefined;
  let admin: Client | undefined;
  let tester: Client | undefined;
  let generated = '';

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'permdock-rbac-'));
    const out = join(dir, 'rls.sql');
    const generate = await run(
      [
        'rls',
        'generate',
        '--target',
        'sql',
        '--dialect',
        'supabase',
        '--rbac',
        'supabase',
        '--authorize',
        'database',
        '--memberships',
        'organization_members:organization_id,user_id,role',
        '--out',
        out,
      ],
      { cwd: FIXTURE },
    );
    if (generate.code !== 0) {
      throw new Error(`PermDock: rls generate exited ${String(generate.code)}`);
    }
    generated = readFileSync(out, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    admin = new Client({ connectionString: container.getConnectionUri() });
    await admin.connect();
    await admin.query(SUPABASE_STUB);
    await admin.query(generated);
    await admin.query(
      `insert into public.user_roles (user_id, role) values ('${STAFF}', 'staff')`,
    );
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
    await tester?.end();
    await admin?.end();
    await container?.stop();
  });

  async function as<T>(
    role: 'authenticated' | 'anon' | 'supabase_auth_admin',
    sub: string | null,
    work: (client: Client) => Promise<T>,
  ): Promise<T> {
    if (tester === undefined) {
      throw new Error('PermDock: tester client was not started');
    }
    const client = tester;
    await client.query('begin');
    try {
      await client.query(`set local role ${role}`);
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify(sub === null ? { role } : { sub, role }),
      ]);
      return await work(client);
    } finally {
      await client.query('rollback');
    }
  }

  it('emits schema-qualified, tenant-aware policies and never service_role', () => {
    expect(generated).not.toMatch(/service_role/iu);
    expect(generated).toContain(
      `"public".authorize('post.update', "orgId"::text)`,
    );
    expect(generated).toContain("set search_path = ''");
    expect(generated).not.toMatch(/for insert\s+to authenticated\s+using/u);
  });

  it('scopes reads to the tenants a user belongs to', async () => {
    expect(await as('authenticated', ADMIN, ids)).toEqual(['a1', 'a2']);
    expect(await as('authenticated', MEMBER, ids)).toEqual(['a1', 'a2']);
    expect(await as('authenticated', OUTSIDER, ids)).toEqual(['g1']);
    expect(await as('authenticated', STAFF, ids)).toEqual(['a1', 'a2', 'g1']);
    await expect(as('anon', null, ids)).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('answers authorize() for the requested tenant only', async () => {
    const check = (sub: string, tenant: string | null): Promise<boolean> =>
      as('authenticated', sub, async (client) => {
        const result = await client.query<{ ok: boolean }>(
          'select public.authorize($1::public.app_permission, $2) as ok',
          ['post.delete', tenant],
        );
        return result.rows[0]?.ok ?? false;
      });
    expect(await check(ADMIN, 'acme')).toBe(true);
    expect(await check(ADMIN, 'globex')).toBe(false);
    expect(await check(ADMIN, null)).toBe(false);
    expect(await check(MEMBER, 'acme')).toBe(false);
  });

  it('limits member updates to their own rows and rejects cross-tenant inserts', async () => {
    const updated = await as('authenticated', MEMBER, async (client) => {
      const own = await client.query(
        `update public.post set id = id where id = 'a1'`,
      );
      const other = await client.query(
        `update public.post set id = id where id = 'a2'`,
      );
      return [own.rowCount, other.rowCount];
    });
    expect(updated).toEqual([1, 0]);

    const inserted = await as('authenticated', MEMBER, async (client) => {
      await client.query(
        `insert into public.post values ('a3', 'acme', '${MEMBER}')`,
      );
      return 'ok';
    });
    expect(inserted).toBe('ok');
    await expect(
      as('authenticated', MEMBER, async (client) => {
        await client.query(
          `insert into public.post values ('g2', 'globex', '${MEMBER}')`,
        );
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('applies a role change on the next statement', async () => {
    if (admin === undefined) {
      throw new Error('PermDock: admin client was not started');
    }
    const deleteOther = (): Promise<number | null> =>
      as('authenticated', ADMIN, async (client) => {
        const result = await client.query(
          `delete from public.post where id = 'a1'`,
        );
        return result.rowCount;
      });
    expect(await deleteOther()).toBe(1);
    await admin.query(
      `update public.organization_members set role = 'member' where user_id = '${ADMIN}'`,
    );
    try {
      expect(await deleteOther()).toBe(0);
    } finally {
      await admin.query(
        `update public.organization_members set role = 'admin' where user_id = '${ADMIN}'`,
      );
    }
  });

  it('lets only supabase_auth_admin run the hook, which writes user_role', async () => {
    const event = JSON.stringify({ user_id: STAFF, claims: { sub: STAFF } });
    const claims = await as('supabase_auth_admin', null, async (client) => {
      const result = await client.query<{
        event: { claims: Record<string, unknown> };
      }>('select public.custom_access_token_hook($1::jsonb) as event', [event]);
      return result.rows[0]?.event.claims;
    });
    expect(claims).toEqual({ sub: STAFF, user_role: 'staff' });

    const none = await as('supabase_auth_admin', null, async (client) => {
      const result = await client.query<{
        event: { claims: Record<string, unknown> };
      }>('select public.custom_access_token_hook($1::jsonb) as event', [
        JSON.stringify({ user_id: MEMBER, claims: { sub: MEMBER } }),
      ]);
      return result.rows[0]?.event.claims;
    });
    expect(none).toEqual({ sub: MEMBER });

    await expect(
      as('authenticated', STAFF, async (client) => {
        await client.query(
          'select public.custom_access_token_hook($1::jsonb)',
          [event],
        );
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
