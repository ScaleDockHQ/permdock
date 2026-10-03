import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'permdock/cli';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/break-glass');

const NURSE = 'u-nurse';

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
grant usage on schema public to authenticated, anon;
create table public.patient (id text primary key, restricted boolean not null);
insert into public.patient values ('p-open', false), ('p-secret', true);
grant select on public.patient to authenticated;
`;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function session(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: '1',
    permission: 'patient.read',
    purpose: 'BTG',
    reason: 'cardiac arrest',
    expiresAt: nowSeconds() + 3600,
    ...extra,
  });
}

async function generate(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'permdock-break-glass-'));
  const out = join(dir, 'rls.sql');
  try {
    const result = await run(
      ['rls', 'generate', '--target', 'sql', '--dialect', 'guc', '--out', out],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('break-glass RLS session function (guc)', () => {
  let db: Postgres | undefined;
  let generated = '';

  beforeAll(async () => {
    generated = await generate();
    db = await startPostgres([SETUP, generated]);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  function asNurse<T>(
    settings: Record<string, string>,
    work: () => Promise<T>,
  ): Promise<T> {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    return db.as(
      {
        role: 'authenticated',
        settings: {
          'app.user_id': NURSE,
          'app.user_role': 'nurse',
          ...settings,
        },
      },
      work,
    );
  }

  it('generates the audit table and the security definer read function, never a break-glass policy', () => {
    expect(generated).toContain(
      'permdock_break_glass_patient(p_permission text)',
    );
    expect(generated).toContain('permdock_break_glass_audit');
    expect(generated).toContain('security definer');
    expect(generated).not.toMatch(/service_role/iu);
    // The break-glass override never becomes a policy: restricted stays denied.
    expect(generated).not.toContain("break_glass' <> ''");
  });

  it('plain RLS still denies the restricted row', async () => {
    const ids = await asNurse({}, async () =>
      (
        await db!.tester.query<{ readonly id: string }>(
          `select id from public.patient order by id`,
        )
      ).rows.map((row) => row.id),
    );
    expect(ids).toEqual(['p-open']);
  });

  it('the function refuses without a valid session', async () => {
    await expect(
      asNurse({}, () =>
        db!.tester.query(
          `select id from permdock.permdock_break_glass_patient('patient.read')`,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      asNurse(
        { 'app.break_glass': session({ expiresAt: nowSeconds() - 60 }) },
        () =>
          db!.tester.query(
            `select id from permdock.permdock_break_glass_patient('patient.read')`,
          ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      asNurse({ 'app.break_glass': session({ reason: '' }) }, () =>
        db!.tester.query(
          `select id from permdock.permdock_break_glass_patient('patient.read')`,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('returns restricted rows and writes an audit row with a valid session', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    // Autocommit (not the rollback wrapper) so the audit insert persists.
    await db.tester.query(`set role authenticated`);
    await db.tester.query(`select set_config('app.user_id', $1, false)`, [
      NURSE,
    ]);
    await db.tester.query(`select set_config('app.break_glass', $1, false)`, [
      session(),
    ]);
    const rows = (
      await db.tester.query<{ readonly id: string }>(
        `select id from permdock.permdock_break_glass_patient('patient.read') order by id`,
      )
    ).rows.map((row) => row.id);
    await db.tester.query(`select set_config('app.break_glass', '', false)`);
    await db.tester.query(`reset role`);

    expect(rows).toEqual(['p-open', 'p-secret']);

    const audit = (
      await db.admin.query<{
        readonly subject: string;
        readonly permission: string;
        readonly purpose: string;
        readonly reason: string;
      }>(
        `select subject, permission, purpose, reason from permdock.permdock_break_glass_audit`,
      )
    ).rows;
    expect(audit).toEqual([
      {
        subject: NURSE,
        permission: 'patient.read',
        purpose: 'BTG',
        reason: 'cardiac arrest',
      },
    ]);
  });
});
