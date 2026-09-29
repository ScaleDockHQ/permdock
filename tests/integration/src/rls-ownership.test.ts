import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'permdock/cli';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import { startPostgres } from './support/postgres.ts';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/ownership',
);

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
create table org_members (org_id text not null, user_id text not null, role text not null);
create table payment (id text primary key, org_id text not null);
insert into org_members values
  ('o1', 'u1', 'primary'), ('o1', 'u2', 'approver'), ('o1', 'u3', 'approver');
`;

describe('ownership triggers in generated RLS', () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'permdock-ownership-'));
    const out = join(dir, 'rls.sql');
    const result = await run(
      ['rls', 'generate', '--target', 'sql', '--dialect', 'guc', '--out', out],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    const sql = readFileSync(out, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([SETUP, sql]);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  /** The hint of the error the statements raise by commit, or `null` when they pass. */
  const attempt = async (statements: string): Promise<string | null> => {
    const admin = db!.admin;
    await admin.query('begin');
    try {
      await admin.query(statements);
      await admin.query('set constraints all immediate');
      return null;
    } catch (error) {
      return (error as { readonly hint?: string }).hint ?? String(error);
    } finally {
      await admin.query('rollback');
    }
  };

  it('caps holders at commit', async () => {
    expect(
      await attempt("insert into org_members values ('o1', 'u4', 'approver')"),
    ).toBe('max-holders');
  });

  it('moves a transfer-only role in one statement or through zero', async () => {
    expect(
      await attempt(
        "update org_members set user_id = 'u4' where org_id = 'o1' and role = 'primary'",
      ),
    ).toBeNull();
    expect(
      await attempt(`
        delete from org_members where org_id = 'o1' and role = 'primary';
        insert into org_members values ('o1', 'u4', 'primary');
      `),
    ).toBeNull();
    expect(
      await attempt("insert into org_members values ('o2', 'u9', 'primary')"),
    ).toBeNull();
  });

  it('refuses a second transfer-only holder and a missing one', async () => {
    expect(
      await attempt("insert into org_members values ('o1', 'u4', 'primary')"),
    ).toBe('transfer-only');
    expect(
      await attempt(
        "delete from org_members where org_id = 'o1' and role = 'primary'",
      ),
    ).toBe('last-holder');
  });

  it('answers permdock_can_assign for the primary only', async () => {
    const can = (user: string, role: string) =>
      db!.as(
        { role: 'authenticated', settings: { 'app.user_id': user } },
        async () =>
          (
            await db!.tester.query<{ readonly ok: boolean }>(
              "select public.permdock_can_assign($1, 'o1') as ok",
              [role],
            )
          ).rows[0]?.ok,
      );
    expect(await can('u1', 'approver')).toBe(true);
    expect(await can('u2', 'approver')).toBe(false);
    expect(await can('', 'approver')).toBe(false);
  });
});
