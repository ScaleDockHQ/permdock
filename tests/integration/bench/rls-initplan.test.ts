import type { Client } from 'pg';

import { run } from 'permdock/cli';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from '../src/support/postgres.ts';

import { startPostgres } from '../src/support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/supabase-rbac');

const ROWS = 10_000;
const TENANTS = 20;
const RUNS = 7;
/** The helper shape must beat the per-row shape by this factor. */
const SPEEDUP = 5;
/** Absolute ceiling for the helper shape's median execution time, in ms. */
const CEILING_MS = 250;
const MEMBER = '00000000-0000-4000-8000-000000000003';

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
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
-- 50 users per tenant; user n belongs to tenant n % ${TENANTS}.
insert into auth.users (id)
  select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
  from generate_series(0, ${TENANTS * 50 - 1}) n;
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members
  select 'org-' || lpad((n % ${TENANTS})::text, 2, '0'),
         ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
         case when n < ${TENANTS} then 'member' else 'admin' end
  from generate_series(0, ${TENANTS * 50 - 1}) n;
create index on public.organization_members (user_id);
-- The per-row shape joins memberships as the caller; the helpers read them as definer.
alter table public.organization_members enable row level security;
create policy "members read their own rows" on public.organization_members
  for select to authenticated using (user_id = (select auth.uid()));
grant select on public.organization_members to authenticated;
create table public.post (
  id text primary key,
  "orgId" text not null,
  "authorId" uuid not null
);
insert into public.post
  select 'p' || n,
         'org-' || lpad((n % ${TENANTS})::text, 2, '0'),
         ('00000000-0000-4000-8000-' || lpad((n % ${TENANTS * 50})::text, 12, '0'))::uuid
  from generate_series(1, ${ROWS}) n;
create index on public.post ("orgId");
`;

// The pre-helper output of `rls generate --rbac supabase --policy-per-role`
// for SELECT: a per-row authorize() call and a correlated membership join.
function perRowPolicies(): string {
  const membership = (role: string): string =>
    `exists (select 1 from "organization_members" m where m."organization_id" = "orgId" and m."user_id" = (select auth.uid()) and m."role" = any('{${role}}'))`;
  const tenant = (role: string, permission: string): string =>
    `(select "public".authorize('${permission}', "orgId"::text)) and (${membership(role)})`;
  const policies = [
    ['staff_post_read', `(select "public".authorize('post.read'))`],
    ['staff_post_list', `(select "public".authorize('post.list'))`],
    ['admin_post_read', tenant('admin', 'post.read')],
    ['admin_post_list', tenant('admin', 'post.list')],
    ['member_post_read', tenant('member', 'post.read')],
    ['member_post_list', tenant('member', 'post.list')],
  ];
  return [
    'drop policy if exists "post_select" on public.post;',
    ...policies.map(
      ([name, using]) =>
        `create policy "${name}" on public.post as permissive for select to authenticated using (${using});`,
    ),
  ].join('\n');
}

type PlanNode = {
  readonly 'Node Type': string;
  readonly 'Actual Loops'?: number;
  readonly 'Actual Rows'?: number;
  readonly 'Function Name'?: string;
  readonly Output?: readonly string[];
  readonly Filter?: string;
  readonly 'Subplan Name'?: string;
  readonly Plans?: readonly PlanNode[];
};

type Explain = {
  readonly Plan: PlanNode;
  readonly 'Execution Time': number;
};

function nodes(plan: PlanNode): readonly PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

function callsHelper(node: PlanNode, helper: string): boolean {
  return (
    node['Function Name'] === helper ||
    (node.Output ?? []).some((item) => item.includes(`${helper}(`))
  );
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

describe('rls helpers run once per statement (InitPlan)', () => {
  let db: Postgres | undefined;

  async function asMember<T>(work: (client: Client) => Promise<T>): Promise<T> {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const client = db.tester;
    return db.as(
      {
        role: 'authenticated',
        settings: {
          'request.jwt.claims': JSON.stringify({
            sub: MEMBER,
            role: 'authenticated',
          }),
        },
      },
      () => work(client),
    );
  }

  async function measure(): Promise<{
    readonly ids: readonly string[];
    readonly plans: readonly Explain[];
  }> {
    const ids = await asMember(async (client) => {
      const result = await client.query<{ id: string }>(
        'select id from public.post order by id',
      );
      return result.rows.map((row) => row.id);
    });
    const plans: Explain[] = [];
    for (let index = 0; index < RUNS; index += 1) {
      const plan = await asMember(async (client) => {
        const result = await client.query<{ 'QUERY PLAN': Explain[] }>(
          'explain (analyze, verbose, format json) select id from public.post',
        );
        return result.rows[0]?.['QUERY PLAN'][0];
      });
      if (plan === undefined) {
        throw new Error('PermDock: EXPLAIN returned no plan');
      }
      plans.push(plan);
    }
    return { ids, plans };
  }

  let helper: Awaited<ReturnType<typeof measure>> | undefined;
  let perRow: Awaited<ReturnType<typeof measure>> | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'permdock-bench-'));
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
      throw new Error(`rls generate: ${generate.stdout}`);
    }
    const generated = readFileSync(out, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([SETUP, generated, 'analyze']);
    helper = await measure();
    await db.admin.query(perRowPolicies());
    perRow = await measure();
  }, 300_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('calls permitted_tenant_ids once, not once per row', () => {
    const plan = helper?.plans[0]?.Plan;
    expect(plan).toBeDefined();
    const calls = nodes(plan!).filter((node) =>
      callsHelper(node, 'permitted_tenant_ids'),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const node of calls) {
      expect(node['Actual Loops']).toBe(1);
    }
    const perRowPlan = perRow?.plans[0]?.Plan;
    const correlated = nodes(perRowPlan!).filter(
      (node) => (node['Actual Loops'] ?? 0) >= ROWS / TENANTS,
    );
    expect(correlated.length).toBeGreaterThan(0);
  });

  it('returns the same rows as the per-row shape', () => {
    expect(helper?.ids).toHaveLength(ROWS / TENANTS);
    expect(helper?.ids).toEqual(perRow?.ids);
  });

  it(`is at least ${String(SPEEDUP)}x faster than the per-row shape`, async ({
    annotate,
  }) => {
    const after = median(helper!.plans.map((plan) => plan['Execution Time']));
    const before = median(perRow!.plans.map((plan) => plan['Execution Time']));
    const loops = (explain: Explain | undefined): number =>
      Math.max(
        ...nodes(explain!.Plan).map((node) => node['Actual Loops'] ?? 0),
      );
    // Surfaced in the reporter so a PR can quote the numbers.
    await annotate(
      `rls-bench: ${String(ROWS)} rows, ${String(TENANTS)} tenants, median of ${String(RUNS)}: per-row ${before.toFixed(2)} ms (max loops ${String(loops(perRow?.plans[0]))}), helpers ${after.toFixed(2)} ms (max loops ${String(loops(helper?.plans[0]))}), ${(before / after).toFixed(1)}x`,
    );
    expect(after * SPEEDUP).toBeLessThanOrEqual(before);
    expect(after).toBeLessThan(CEILING_MS);
  });
});
