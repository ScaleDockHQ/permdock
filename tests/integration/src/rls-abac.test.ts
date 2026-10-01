import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'permdock/cli';
import { type RlsParityFixture, rlsParity } from 'permdock/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import { permissions } from '../fixtures/abac/permissions.ts';
import { policy } from '../fixtures/abac/policy.ts';
import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/abac');

type Dialect = 'supabase' | 'neon' | 'guc';

// The token functions each platform provides, over the claims rlsParity sets.
const STUBS: Record<Dialect, string> = {
  supabase: `
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
`,
  neon: `
create schema auth;
create function auth.session() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.user_id() returns text language sql stable as $$
  select auth.session() ->> 'sub'
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
`,
  guc: '',
};

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
grant usage on schema public to authenticated, anon;
create table report (id text primary key, region text not null, clearance integer not null);
create table ticket (id text primary key, region text);
create table record (id text primary key, region text);
insert into report values ('r-eu-low', 'eu', 1), ('r-eu-high', 'eu', 5), ('r-us', 'us', 1);
insert into ticket values ('t-eu', 'eu'), ('t-uk', 'uk'), ('t-us', 'us'), ('t-none', null);
insert into record values ('c-eu', 'eu'), ('c-us', 'us'), ('c-none', null);
create table note (id text primary key, title text not null);
insert into note values ('n-literal', 'save 50%_off today'), ('n-wildcard', 'save 50 percent off today');
`;

const GRANTS = `
grant select on report to authenticated;
grant select, update on ticket to authenticated;
grant select, delete on record to authenticated;
grant select on note to authenticated;
`;

const EU = '00000000-0000-4000-8000-00000000e001';
const US = '00000000-0000-4000-8000-00000000e002';
const BARE = '00000000-0000-4000-8000-00000000e003';
const TEXTUAL = '00000000-0000-4000-8000-00000000e004';

const subjects = {
  eu: {
    id: EU,
    claims: {
      attrs: {
        region: 'eu',
        clearance: 3,
        regions: ['eu', 'uk'],
        blocked: ['us'],
      },
    },
  },
  us: {
    id: US,
    claims: {
      attrs: { region: 'us', clearance: 1, regions: ['us'], blocked: [] },
    },
  },
  bare: { id: BARE },
  textual: {
    id: TEXTUAL,
    claims: {
      attrs: { region: 'eu', clearance: '3', regions: 'eu', blocked: 'us' },
    },
  },
} as const;

type Subject = RlsParityFixture['subject'];

function reportCase(
  name: string,
  subject: Subject,
  id: string,
  region: string,
  clearance: number,
): RlsParityFixture {
  return {
    name: `report: ${name}`,
    subject,
    permission: permissions.report.read,
    row: { id, region, clearance },
    table: 'report',
  };
}

function regionCase(
  table: 'ticket' | 'record',
  name: string,
  subject: Subject,
  id: string,
  region: string | null,
): RlsParityFixture {
  return {
    name: `${table}: ${name}`,
    subject,
    permission:
      table === 'ticket'
        ? permissions.ticket.update
        : permissions.record.delete,
    row: { id, region },
    table,
  };
}

const fixtures: readonly RlsParityFixture[] = [
  reportCase(
    'eu reads its region below its clearance',
    subjects.eu,
    'r-eu-low',
    'eu',
    1,
  ),
  reportCase(
    'eu reads nothing above its clearance',
    subjects.eu,
    'r-eu-high',
    'eu',
    5,
  ),
  reportCase(
    'eu reads nothing in another region',
    subjects.eu,
    'r-us',
    'us',
    1,
  ),
  reportCase('us reads its own region', subjects.us, 'r-us', 'us', 1),
  reportCase(
    'a string clearance never compares as a number',
    subjects.textual,
    'r-eu-low',
    'eu',
    1,
  ),
  reportCase('no attributes read nothing', subjects.bare, 'r-eu-low', 'eu', 1),
  regionCase(
    'ticket',
    'eu updates a region in its list',
    subjects.eu,
    't-eu',
    'eu',
  ),
  regionCase(
    'ticket',
    'eu updates the second region in its list',
    subjects.eu,
    't-uk',
    'uk',
  ),
  regionCase(
    'ticket',
    'eu updates nothing outside its list',
    subjects.eu,
    't-us',
    'us',
  ),
  regionCase(
    'ticket',
    'a null region is in no list',
    subjects.eu,
    't-none',
    null,
  ),
  regionCase(
    'ticket',
    'a scalar claim is not a list',
    subjects.textual,
    't-eu',
    'eu',
  ),
  regionCase(
    'ticket',
    'no attributes update nothing',
    subjects.bare,
    't-eu',
    'eu',
  ),
  regionCase(
    'record',
    'eu deletes outside its blocklist',
    subjects.eu,
    'c-eu',
    'eu',
  ),
  regionCase(
    'record',
    'eu deletes nothing on its blocklist',
    subjects.eu,
    'c-us',
    'us',
  ),
  regionCase(
    'record',
    'an empty blocklist blocks nothing',
    subjects.us,
    'c-us',
    'us',
  ),
  regionCase(
    'record',
    'a null region is never outside a list',
    subjects.us,
    'c-none',
    null,
  ),
  regionCase(
    'record',
    'a missing blocklist blocks nothing',
    subjects.bare,
    'c-us',
    'us',
  ),
  regionCase(
    'record',
    'a scalar blocklist is not a list',
    subjects.textual,
    'c-us',
    'us',
  ),
  {
    name: 'note: contains matches % and _ literally',
    subject: subjects.eu,
    permission: permissions.note.read,
    row: { id: 'n-literal', title: 'save 50%_off today' },
    table: 'note',
  },
  {
    name: 'note: contains never treats % and _ as wildcards',
    subject: subjects.eu,
    permission: permissions.note.read,
    row: { id: 'n-wildcard', title: 'save 50 percent off today' },
    table: 'note',
  },
];

const expected: Readonly<Record<string, boolean>> = {
  'report: eu reads its region below its clearance': true,
  'report: eu reads nothing above its clearance': false,
  'report: eu reads nothing in another region': false,
  'report: us reads its own region': true,
  'report: a string clearance never compares as a number': false,
  'report: no attributes read nothing': false,
  'ticket: eu updates a region in its list': true,
  'ticket: eu updates the second region in its list': true,
  'ticket: eu updates nothing outside its list': false,
  'ticket: a null region is in no list': false,
  'ticket: a scalar claim is not a list': false,
  'ticket: no attributes update nothing': false,
  'record: eu deletes outside its blocklist': true,
  'record: eu deletes nothing on its blocklist': false,
  'record: an empty blocklist blocks nothing': true,
  'record: a null region is never outside a list': false,
  'record: a missing blocklist blocks nothing': true,
  'record: a scalar blocklist is not a list': true,
  'note: contains matches % and _ literally': true,
  'note: contains never treats % and _ as wildcards': false,
};

async function generate(dialect: Dialect): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `permdock-abac-${dialect}-`));
  const out = join(dir, 'rls.sql');
  try {
    const result = await run(
      [
        'rls',
        'generate',
        '--target',
        'sql',
        '--dialect',
        dialect,
        '--out',
        out,
      ],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate --dialect ${dialect}: ${result.stderr}`);
    }
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.each(['supabase', 'neon', 'guc'] as const)(
  'RLS parity for subject attributes (%s)',
  (dialect) => {
    let db: Postgres | undefined;
    let generated = '';

    beforeAll(async () => {
      generated = await generate(dialect);
      db = await startPostgres([SETUP, STUBS[dialect], generated, GRANTS]);
    }, 120_000);

    afterAll(async () => {
      await db?.stop();
    });

    it('compiles nested claim paths, typed casts and array claims', () => {
      expect(generated).not.toMatch(/service_role/iu);
      expect(generated).toMatch(/attrs/u);
      expect(generated).toContain('::numeric');
      expect(generated).toContain('jsonb_array_elements');
    });

    it('agrees with can() on the region and clearance matrix', async () => {
      if (db === undefined) {
        throw new Error('PermDock: Postgres was not started');
      }
      const client = db.tester;
      const report = await rlsParity(policy, {
        dialect,
        snapshot: true,
        fixtures,
        query: async (sql, values) => {
          const result = await client.query(
            sql,
            values === undefined ? undefined : [...values],
          );
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
      });
      expect(
        Object.fromEntries(
          report.results.map((item) => [item.name, item.granted]),
        ),
      ).toEqual(expected);
      expect(report.results.filter((item) => !item.ok)).toEqual([]);
    });
  },
);
