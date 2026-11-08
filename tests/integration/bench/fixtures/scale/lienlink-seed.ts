import type { Cell, RowTier } from "./tiers.ts";

import {
  CELLS,
  CUSTOM_PERMISSION_ROWS,
  KIND,
  OWNERS,
  ROW_TIERS,
  TEAMS_PER_TENANT,
  TENANTS,
  callerOf,
  uuidSql,
} from "./tiers.ts";

/**
 * Lienlink-shaped seed over `tests/integration/fixtures/declarative-jobs`:
 * `jobs` in 1,000 tenants, one party per job, one attachment per four jobs, and
 * one caller per matrix cell with `memberships` tenant memberships of `roles`
 * roles each.
 */

const tenant = (n: string): string => uuidSql(KIND.tenant, n);
const user = (n: string): string => uuidSql(KIND.user, n);

/** Tables the declarative-jobs schema does not have. */
export const ATTACHMENTS_DDL = `
create table public.job_attachments (
  id uuid primary key,
  job_id uuid not null references public.jobs (id) on delete cascade,
  path text not null
);
alter table public.job_attachments enable row level security;
create policy "job_attachments_select" on public.job_attachments
  for select to authenticated
  using (exists (select 1 from public.jobs j where j.id = job_attachments.job_id and permdock.can_jobs(j, 'jobs.read'::text)));
grant select on public.job_attachments to authenticated;
`;

/** The `jobs` policy Lienlink writes by hand (rowHelpers: `can_jobs` per row). */
export const JOBS_POLICY_PER_ROW = `
alter table public.jobs enable row level security;
grant select on public.jobs to authenticated;
create policy "jobs_select" on public.jobs
  for select to authenticated
  using (permdock.can_jobs(jobs, 'jobs.read'::text));
`;

export function jobsSeed(tier: RowTier): string {
  const jobs = ROW_TIERS[tier];
  return `
insert into auth.users (id)
  select ${user("n")} from generate_series(0, ${OWNERS - 1}) n;
insert into public.jobs (id, organization_id, owner_id, team_id)
  select ${uuidSql(KIND.job, "n")},
         ${tenant(`n % ${TENANTS}`)},
         ${user(`n % ${OWNERS}`)},
         ${uuidSql(KIND.team, `(n % ${TENANTS}) * ${TEAMS_PER_TENANT} + n % ${TEAMS_PER_TENANT}`)}
  from generate_series(0, ${jobs - 1}) n;
insert into public.job_parties (id, job_id, name)
  select ${uuidSql(KIND.party, "n")}, ${uuidSql(KIND.job, "n")}, 'party ' || n
  from generate_series(0, ${jobs - 1}) n;
insert into public.job_attachments (id, job_id, path)
  select ${uuidSql(KIND.attachment, "n")}, ${uuidSql(KIND.job, "n * 4")}, 'a/' || n
  from generate_series(0, ${Math.ceil(jobs / 4) - 1}) n;
create index on public.jobs (organization_id);
create index on public.job_parties (job_id);
create index on public.job_attachments (job_id);
analyze;
`;
}

/** Roles held by one membership: `member`, `support`, then custom roles. */
function roleNames(cell: Cell): string {
  return `case
    when k = 0 then 'member'
    when k = 1 then 'support'
    when ${String(cell.custom)} > 0 then 'c' || ((k - 2) % ${String(Math.max(cell.custom, 1))})
    else 'x' || k
  end`;
}

/**
 * One caller per cell. Every caller belongs to tenants 0 to memberships - 1 and
 * holds `roles` roles in each. Tenants 0 to 999 each carry up to `customRoles`
 * custom roles `c0`...: call it again with a larger count to grow the table to
 * the next tier.
 */
export function membershipSeed(): string {
  return CELLS.map((cell) => {
    const id = callerOf(cell);
    return `
insert into auth.users (id) values ('${id}');
insert into better_supabase.memberships (organization_id, user_id, role)
  select ${tenant("t")}, '${id}', 'member' from generate_series(0, ${cell.memberships - 1}) t;
insert into better_supabase.membership_roles (organization_id, user_id, role)
  select ${tenant("t")}, '${id}', ${roleNames(cell)}
  from generate_series(0, ${cell.memberships - 1}) t, generate_series(0, ${cell.roles - 1}) k;
`;
  }).join("\n");
}

/** Grants of one custom role, kept at 8 so 500 roles × 1,000 tenants is 4M. */
const GRANTS_PER_ROLE = CUSTOM_PERMISSION_ROWS / (500 * TENANTS);

/**
 * Custom roles `c<from>` to `c<to - 1>` in every tenant, as `roles`,
 * `role_permissions` and the `permdock.custom_role_permissions` table, inserted
 * with the sync triggers off, then compiled in one recompile.
 */
export function customRolesSeed(from: number, to: number): string {
  if (to <= from) {
    return "";
  }
  const perm = `case when g = 0 then 'jobs.read' else 'filler.p' || g end`;
  return `
alter table public.roles disable trigger user;
alter table public.role_permissions disable trigger user;
alter table permdock.custom_role_permissions disable trigger user;
insert into public.roles (id, organization_id, name)
  select ${uuidSql(KIND.role, `t * 1000 + r`)}, ${tenant("t")}, 'c' || r
  from generate_series(0, ${TENANTS - 1}) t, generate_series(${from}, ${to - 1}) r;
insert into public.role_permissions (role_id, permission, level)
  select ${uuidSql(KIND.role, `t * 1000 + r`)}, ${perm}, null
  from generate_series(0, ${TENANTS - 1}) t, generate_series(${from}, ${to - 1}) r,
       generate_series(0, ${GRANTS_PER_ROLE - 1}) g;
insert into permdock.custom_role_permissions (tenant_id, scope, role, permission, effect)
  select ${tenant("t")}, 'tenant', 'c' || r, ${perm}, 'allow'
  from generate_series(0, ${TENANTS - 1}) t, generate_series(${from}, ${to - 1}) r,
       generate_series(0, ${GRANTS_PER_ROLE - 1}) g;
alter table public.roles enable trigger user;
alter table public.role_permissions enable trigger user;
alter table permdock.custom_role_permissions enable trigger user;
select permdock.permdock_recompile_custom_roles();
analyze permdock.custom_role_permissions;
analyze permdock.custom_role_compiled;
`;
}
