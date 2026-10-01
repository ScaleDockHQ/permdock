import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { PermDockConfig } from '../../src/cli/types.ts';
import type { SupabaseHookManifest } from '../../src/supabase/manifest.ts';

import {
  missingHelpersInDb,
  missingHelpersInFiles,
  missingHelpersMessage,
  pd039,
} from '../../src/cli/supabase-setup.ts';
import { fakeSql } from '../fakes/sql.ts';

const tmpRoot = path.join(import.meta.dirname, '../../tmp');
mkdirSync(tmpRoot, { recursive: true });
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(path.join(tmpRoot, 'supabase-setup-'));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

function manifestOf(
  schema: string,
  claims: SupabaseHookManifest['claims'] = [],
): SupabaseHookManifest {
  const fields = {
    hook: {
      schema: 'public',
      function: 'custom_access_token_hook',
      out: 'supabase/migrations/0002_hook.sql',
    },
    helpers: {
      schema,
      functions: ['permdock_has', 'permitted_org_ids', 'member_org_ids_for'],
    },
    budget: { bytes: 20, measure: 'json' },
    claims,
  } satisfies Pick<
    SupabaseHookManifest,
    'hook' | 'helpers' | 'budget' | 'claims'
  >;
  // SAFETY: supabase-setup reads only hook, helpers, budget and claims.
  return fields as unknown as SupabaseHookManifest;
}

const config: PermDockConfig = {};

describe('missingHelpersInFiles', () => {
  it('finds helpers in migrations and rls.out, never in the hook file', () => {
    const cwd = project({
      'supabase/migrations/0001_rls.sql':
        'create or replace function public.permdock_has(p text) returns boolean as $$ $$;\ncreate function "permitted_org_ids"(p text) returns setof uuid as $$ $$;\ncreate function public.not_a_helper() returns void as $$ $$;',
      'supabase/migrations/0002_hook.sql':
        'create function member_org_ids_for(p uuid) returns setof uuid as $$ $$;',
    });
    expect(missingHelpersInFiles(cwd, config, manifestOf('public'))).toEqual([
      'member_org_ids_for',
    ]);
  });

  it('needs the schema qualifier outside public and reads rls.out', () => {
    const cwd = project({
      'db/rls.sql':
        'create function "authz".permdock_has(p text) returns boolean as $$ $$;\ncreate function authz.permitted_org_ids(p text) returns setof uuid as $$ $$;\ncreate function member_org_ids_for(p uuid) returns setof uuid as $$ $$;',
    });
    expect(
      missingHelpersInFiles(
        cwd,
        { rls: { out: 'db/rls.sql' }, doctor: { migrations: [] } },
        manifestOf('authz'),
      ),
    ).toEqual(['member_org_ids_for']);
  });

  it('skips an rls.out folder', () => {
    const cwd = project({
      'rls/0001.sql': 'create function permdock_has() as $$ $$;',
    });
    expect(
      missingHelpersInFiles(
        cwd,
        { rls: { out: 'rls' }, doctor: { migrations: [] } },
        manifestOf('public'),
      ),
    ).toHaveLength(3);
  });
});

describe('missingHelpersInDb', () => {
  it('asks pg_proc for the helpers in the helpers schema', async () => {
    const sql = fakeSql(() => ({
      rows: [{ proname: 'permdock_has' }, { proname: 'permitted_org_ids' }],
    }));
    const missing = await missingHelpersInDb(
      'postgres://fake',
      manifestOf('authz'),
      sql.connect,
    );
    expect(missing).toEqual(['member_org_ids_for']);
    expect(sql.calls[0]?.values).toEqual([
      'authz',
      ['permdock_has', 'permitted_org_ids', 'member_org_ids_for'],
    ]);
    expect(sql.ended()).toBe(true);
  });

  it('ends the client when the query fails', async () => {
    const sql = fakeSql(() => ({ code: '42501' }));
    await expect(
      missingHelpersInDb('postgres://fake', manifestOf('public'), sql.connect),
    ).rejects.toThrow('SQLSTATE 42501');
    expect(sql.ended()).toBe(true);
  });

  it('wraps a connection failure', async () => {
    await expect(
      missingHelpersInDb(
        'postgres://permdock:permdock@127.0.0.1:1/missing',
        manifestOf('public'),
      ),
    ).rejects.toThrow('supabase hook generate --db could not connect');
  });
});

describe('pd039', () => {
  it('names the missing helpers', () => {
    const manifest = manifestOf('public');
    expect(missingHelpersMessage(manifest, ['permdock_has'])).toMatch(
      /^PD039 schema public has no permdock_has:/u,
    );
    const findings = pd039({ cwd: project({}), config, manifest });
    expect(findings.map((finding) => finding.message)).toEqual([
      "schema public has no permdock_has, permitted_org_ids, member_org_ids_for: the hook's claims are read by these helpers; run permdock rls generate and apply its migration",
    ]);
  });

  it('flags oversized claims and dropped memberships in the claims fixture', () => {
    const cwd = project({
      'supabase/migrations/0001.sql':
        'create function permdock_has() as $$ $$; create function permitted_org_ids() as $$ $$; create function member_org_ids_for() as $$ $$;',
      'claims.json': JSON.stringify([
        {
          plan: 'enterprise-with-a-long-name',
          memberships: [{ scope: 'org', id: 'o1', roles: [] }],
        },
        null,
        'text',
        { plan: 'pro', small: 1 },
        { memberships: [{ scope: 'org', id: 'o1', roles: ['admin'] }] },
      ]),
    });
    const findings = pd039({
      cwd,
      config: { doctor: { claims: 'claims.json' } },
      manifest: manifestOf('public', [
        { name: 'memberships', source: 'permdock', budget: true },
        { name: 'plan', source: 'public.plan_claim', budget: true },
        { name: 'small', source: 'public.small_claim', budget: true },
      ]),
    });
    expect(findings.map((finding) => finding.message)).toEqual([
      'claim plan is 29 bytes of JSON in claims.json, more than the 20-byte memberships budget',
      'sample 0 in claims.json has memberships [0] that subjectFromSupabase drops (membership-dropped)',
    ]);
  });

  it('reads a fixture that is not an array as no samples', () => {
    const cwd = project({
      'migrations/0001.sql':
        'create function permdock_has() as $$ $$; create function permitted_org_ids() as $$ $$; create function member_org_ids_for() as $$ $$;',
      'claims.json': '{"plan":"x"}',
    });
    expect(
      pd039({
        cwd,
        config: { doctor: { claims: 'claims.json' } },
        manifest: manifestOf('public'),
      }),
    ).toEqual([]);
  });
});
