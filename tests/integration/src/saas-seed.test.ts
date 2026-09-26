import { saasSchemaSql, saasSeed, saasSeedSql } from '@permdock/testing/saas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import { startPostgres } from './support/postgres.ts';

describe('shared SaaS domain in Postgres', () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    db = await startPostgres([
      saasSchemaSql,
      saasSeedSql(),
      'grant select on org, org_member, project, doc to tester',
    ]);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('loads every seeded row', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const counts = await db.admin.query<{ name: string; count: string }>(`
      select 'org' as name, count(*) from org
      union all select 'project', count(*) from project
      union all select 'doc', count(*) from doc
    `);
    expect(
      Object.fromEntries(
        counts.rows.map((row) => [row.name, Number(row.count)]),
      ),
    ).toEqual({
      org: saasSeed.orgs.length,
      project: saasSeed.projects.length,
      doc: saasSeed.docs.length,
    });
  });

  it('forces RLS on row tables: no policy means no rows for tester', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const client = db.tester;
    const rows = await db.as({}, () => client.query('select id from project'));
    expect(rows.rowCount).toBe(0);
  });
});
