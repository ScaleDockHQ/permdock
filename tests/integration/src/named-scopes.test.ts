import type { Permission, Principal } from 'permdock';
import type { RlsParityFixture, RlsQueryFn } from 'permdock/testing';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'permdock/cli';
import { rlsParity } from 'permdock/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import {
  assets,
  documents,
  permissions,
  personas,
  policy,
} from '../fixtures/named-scopes/policy.ts';
import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/named-scopes');

const values = (rows: readonly Record<string, string>[], keys: string[]) =>
  rows
    .map((row) => `(${keys.map((key) => `'${row[key] ?? ''}'`).join(', ')})`)
    .join(', ');

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
grant usage on schema public to authenticated, anon;
create table organization_users (
  organization_id text not null,
  user_id text not null,
  role text not null
);
create table customer_contacts (
  customer_id text not null,
  organization_id text not null,
  user_id text not null,
  role text not null
);
insert into organization_users values
  ('T', 'u_owner', 'owner'), ('B', 'u_owner', 'owner'),
  ('B', 'u_viewer', 'viewer'), ('T', 'u_staff_contact', 'member');
insert into customer_contacts values
  ('A', 'T', 'u_private', 'contact'), ('G', 'T', 'u_business', 'contact'),
  ('C', 'B', 'u_staff_contact', 'contact');
create table quote (
  id text primary key, organization_id text not null, customer_id text not null, status text not null
);
create table invoice (
  id text primary key, organization_id text not null, customer_id text not null, status text not null
);
create table asset (id text primary key, organization_id text not null, customer_id text not null);
create table organization (id text primary key);
insert into organization values ('T'), ('B');
insert into quote values ${values(documents, ['id', 'organization_id', 'customer_id', 'status'])};
insert into invoice values ${values(documents, ['id', 'organization_id', 'customer_id', 'status'])};
insert into asset values ${values(assets, ['id', 'organization_id', 'customer_id'])};
grant select, insert, update, delete on quote, invoice, asset to authenticated;
`;

type Subject = RlsParityFixture['subject'];

function subjectOf(principal: Principal, tenant?: string): Subject {
  const active = tenant ?? principal.tenant;
  return {
    id: principal.id,
    roles: principal.roles ?? [],
    memberships: principal.memberships ?? [],
    ...(active === undefined ? {} : { tenant: active }),
  };
}

const subjects: Readonly<Record<string, Subject>> = {
  owner: subjectOf(personas.owner),
  ownerInB: subjectOf(personas.owner, 'B'),
  viewer: subjectOf(personas.viewer),
  privateContact: subjectOf(personas.privateContact),
  businessContact: subjectOf(personas.businessContact),
  staffContact: subjectOf(personas.staffContact),
  staffContactInB: subjectOf(personas.staffContact, 'B'),
  platformAdmin: subjectOf(personas.platformAdmin),
};

const leaves: readonly (readonly [Permission, string])[] = [
  [permissions.quote.read, 'quote'],
  [permissions.quote.update, 'quote'],
  [permissions.invoice.read, 'invoice'],
  [permissions.asset.read, 'asset'],
  [permissions.asset.update, 'asset'],
  [permissions.asset.delete, 'asset'],
];

const fixtures: readonly RlsParityFixture[] = Object.entries(subjects).flatMap(
  ([name, subject]) =>
    leaves.flatMap(([permission, table]) =>
      (table === 'asset' ? assets : documents).map((row) => ({
        name: `${name} ${permission.key} ${row.id}`,
        subject,
        permission,
        row,
        table,
      })),
    ),
);

async function generate(cwd: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'permdock-scopes-'));
  const out = join(dir, 'rls.sql');
  const result = await run(
    ['rls', 'generate', '--target', 'sql', '--dialect', 'guc', '--out', out],
    { cwd },
  );
  if (result.code !== 0) {
    throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
  }
  const sql = readFileSync(out, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return sql;
}

describe.each([
  { mode: 'database', cwd: FIXTURE },
  { mode: 'jwt', cwd: join(FIXTURE, 'jwt') },
])('named scopes in generated RLS ($mode mode)', ({ cwd }) => {
  let db: Postgres | undefined;
  let generated = '';

  beforeAll(async () => {
    generated = await generate(cwd);
    db = await startPostgres([SETUP, generated]);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  const query: RlsQueryFn = async (sql, params) => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    try {
      const result = await db.tester.query(
        sql,
        params === undefined ? undefined : [...params],
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
  };

  it('emits one permitted_<scope>_ids helper per declared scope', () => {
    expect(generated).toContain('permitted_organization_ids(p_grant text)');
    expect(generated).toContain('permitted_customer_ids(p_grant text)');
    expect(generated).not.toContain('permitted_tenant_ids');
    expect(generated).not.toMatch(/service_role/i);
  });

  it('agrees with decide and the snapshot for every persona, permission and row', async () => {
    const report = await rlsParity(policy, {
      dialect: 'guc',
      fixtures,
      query,
      snapshot: true,
    });
    expect(report.results.filter((item) => !item.ok)).toEqual([]);
    const allowed = (name: string): string[] =>
      report.results
        .filter((item) => item.name.startsWith(`${name} `) && item.granted)
        .map((item) => item.name.slice(name.length + 1));
    expect(allowed('privateContact')).toEqual([
      'quote.read d_a_sent',
      'quote.read d_a_accepted',
      'invoice.read d_a_sent',
      'invoice.read d_a_accepted',
      'asset.read a_a_sent',
      'asset.read a_a_draft',
      'asset.read a_a_accepted',
    ]);
    expect(allowed('staffContactInB')).toEqual([
      'quote.read d_c_sent',
      'invoice.read d_c_sent',
      'asset.read a_c_sent',
    ]);
    expect(allowed('platformAdmin')).toEqual([]);
  });

  it('gives an owner organization ids and no customer ids (no cascade)', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const claims = {
      'app.user_id': 'u_owner',
      'app.user_role': '',
      'app.tenant_id': 'T',
      'app.memberships': JSON.stringify(personas.owner.memberships),
    };
    const keys = (
      await db.admin.query<{ readonly grant_key: string }>(
        `select distinct grant_key from public.role_permissions where permission = 'quote.read'`,
      )
    ).rows.map((row) => row.grant_key);
    const ids = async (helper: string): Promise<string[]> =>
      db!.as({ role: 'authenticated', settings: claims }, async () => {
        const result = await db!.tester.query<{ readonly id: string }>(
          `select distinct id from unnest($1::text[]) k, public.${helper}(k) id`,
          [keys],
        );
        return result.rows.map((row) => row.id);
      });
    expect(await ids('permitted_organization_ids')).toEqual(['T']);
    expect(await ids('permitted_customer_ids')).toEqual([]);
  });
});
