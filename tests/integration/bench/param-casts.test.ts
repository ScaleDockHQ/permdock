import { fromTable } from 'permdock/supabase';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from '../src/support/postgres.ts';

import { startPostgres } from '../src/support/postgres.ts';

const USERS = 2_000;
const PER_USER = 5;
const USER = '00000000-0000-4000-8000-000000000007';

const SETUP = `
create table public.memberships (
  user_id uuid not null,
  scope text not null,
  scope_id text not null,
  role text not null
);
insert into public.memberships
  select ('00000000-0000-4000-8000-' || lpad((n % ${USERS})::text, 12, '0'))::uuid,
         'organization', 'org-' || n, 'member'
  from generate_series(0, ${USERS * PER_USER - 1}) n;
create index memberships_user_id on public.memberships (user_id);
`;

type PlanNode = {
  readonly 'Node Type': string;
  readonly 'Index Name'?: string;
  readonly 'Relation Name'?: string;
  readonly Plans?: readonly PlanNode[];
};

function nodes(plan: PlanNode): readonly PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

describe('membership sources compare the user column uncast', () => {
  let db: Postgres | undefined;
  const source = fromTable({ table: 'memberships' });

  async function plan(select: string): Promise<readonly PlanNode[]> {
    const client = db!.admin;
    await client.query('deallocate all');
    await client.query(`prepare membership_rows as ${select}`);
    const result = await client.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
      `explain (format json) execute membership_rows('${USER}')`,
    );
    const root = result.rows[0]?.['QUERY PLAN'][0]?.Plan;
    if (root === undefined) {
      throw new Error('PermDock: EXPLAIN returned no plan');
    }
    return nodes(root);
  }

  beforeAll(async () => {
    db = await startPostgres([SETUP, 'analyze']);
  }, 300_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('reads one user through the user_id index', async () => {
    const scans = await plan(source.sql.select('$1'));
    expect(
      scans.some((node) => node['Index Name'] === 'memberships_user_id'),
    ).toBe(true);
    expect(
      scans.some(
        (node) =>
          node['Node Type'] === 'Seq Scan' &&
          node['Relation Name'] === 'memberships',
      ),
    ).toBe(false);
    const rows = await db!.admin.query(source.sql.select('$1'), [USER]);
    expect(rows.rows).toHaveLength(PER_USER);
  });

  it('scans the table when the column is cast instead', async () => {
    const cast = source.sql
      .select('$1')
      .replace('m."user_id" = $1', 'm."user_id"::text = $1::text');
    expect(cast).not.toBe(source.sql.select('$1'));
    const scans = await plan(cast);
    expect(
      scans.some((node) => node['Index Name'] === 'memberships_user_id'),
    ).toBe(false);
  });
});
