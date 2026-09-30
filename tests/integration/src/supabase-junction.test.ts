import type { SqlQuery } from 'permdock/supabase';
import type { Client } from 'pg';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'permdock/cli';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import { membership } from '../fixtures/supabase-junction/sources.ts';
import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/supabase-junction');

const MEMBER = '00000000-0000-4000-8000-0000000000b1';
const OUTSIDER = '00000000-0000-4000-8000-0000000000b2';

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
grant authenticated, anon, supabase_auth_admin to tester;
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
grant usage on schema auth to supabase_auth_admin;
grant select on auth.users to supabase_auth_admin;
insert into auth.users (id) values ('${MEMBER}'), ('${OUTSIDER}');
create schema better_supabase;
create table better_supabase.memberships (org_id text not null, user_id uuid not null, role text not null);
insert into better_supabase.memberships values ('T', '${MEMBER}', 'admin'), ('B', '${MEMBER}', 'viewer');
`;

describe('fromJunction over a schema-qualified table', () => {
  let db: Postgres | undefined;
  let generated = '';

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'permdock-junction-'));
    const out = join(dir, 'hook.sql');
    const result = await run(['supabase', 'hook', 'generate', '--out', out], {
      cwd: FIXTURE,
    });
    if (result.code !== 0) {
      throw new Error(`hook generate: ${result.stdout}${result.stderr}`);
    }
    generated = readFileSync(out, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([SETUP, generated]);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function mint(user: string): Promise<Record<string, unknown>> {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const client: Client = db.tester;
    return db.as({ role: 'supabase_auth_admin' }, async () => {
      const result = await client.query<{
        event: { claims: Record<string, unknown> };
      }>('select public.custom_access_token_hook($1::jsonb) as event', [
        JSON.stringify({
          user_id: user,
          claims: { sub: user, role: 'authenticated' },
        }),
      ]);
      const claims = result.rows[0]?.event.claims;
      if (claims === undefined) {
        throw new Error('PermDock: the hook returned no claims');
      }
      return claims;
    });
  }

  it('quotes the schema and table separately in the hook and the source', () => {
    expect(generated).toContain('"better_supabase"."memberships"');
    expect(generated).not.toContain('"better_supabase.memberships"');
    expect(membership().sql.select('$1')).toContain(
      '"better_supabase"."memberships"',
    );
  });

  it('writes the same memberships the in-process source loads', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const admin = db.admin;
    const query: SqlQuery = async (text, values) =>
      (await admin.query(text, [...values])).rows;
    const expected = [
      { scope: 'organization', id: 'B', roles: ['viewer'] },
      { scope: 'organization', id: 'T', roles: ['admin'] },
    ];
    expect((await mint(MEMBER))['memberships']).toEqual(expected);
    expect((await mint(OUTSIDER))['memberships']).toEqual([]);
    const loaded = await membership(query).membershipsFor({ id: MEMBER }, {});
    expect(
      loaded.toSorted((a, b) =>
        String('id' in a ? a.id : '').localeCompare(
          String('id' in b ? b.id : ''),
        ),
      ),
    ).toEqual(expected);
  });
});
