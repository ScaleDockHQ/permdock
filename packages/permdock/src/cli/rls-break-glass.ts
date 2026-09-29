import type { Policy } from '../index.ts';
import type { RlsSqlContext } from './rls-sql.ts';

import { tableFor } from './rls-compile.ts';
import { qualified } from './rls-helpers.ts';
import {
  quoteIdent,
  quoteTable,
  subjectClaimJsonSql,
  subjectIdSql,
} from './rls-sql.ts';

/** The audit table every generated break-glass read writes to. Part of the SQL contract. */
export const BREAK_GLASS_AUDIT = 'permdock_break_glass_audit';

const IDENT = /^[a-z][a-z0-9_]*$/u;

/** One resource reachable by a break-glass read: its function reads this table. */
export type BreakGlassEntry = {
  readonly resource: string;
  readonly table: string;
};

/**
 * The resources a `breakGlass` grant targets, with the table each reads. A
 * break-glass grant is non-portable, so `compileGrants` never turns it into a
 * policy; the server reads restricted rows through the generated function
 * instead, which is why plain RLS keeps denying them.
 */
export function breakGlassEntries(
  policy: Policy,
  tables: Readonly<Record<string, string>> | undefined,
): readonly BreakGlassEntry[] {
  const byResource = new Map<string, string>();
  for (const grant of policy.grants) {
    if (grant.breakGlass === undefined) {
      continue;
    }
    const resource = grant.permission.resource;
    if (!byResource.has(resource)) {
      byResource.set(resource, tableFor(resource, tables));
    }
  }
  return [...byResource].map(([resource, table]) => ({ resource, table }));
}

function functionName(resource: string): string {
  if (!IDENT.test(resource)) {
    throw new Error(`PermDock CLI: unsafe break-glass resource '${resource}'`);
  }
  return `permdock_break_glass_${resource}`;
}

function qualifiedTable(name: string): string {
  return quoteTable(name.includes('.') ? name : `public.${name}`);
}

function auditSql(ctx: RlsSqlContext): string {
  const audit = qualified(ctx, quoteIdent(BREAK_GLASS_AUDIT));
  return `-- break-glass audit: one row per session that read restricted data
-- RLS never compiles a break-glass override, so restricted rows stay denied to a direct read
create table if not exists ${audit} (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  subject text,
  permission text not null,
  purpose text,
  reason text not null
);
alter table ${audit} enable row level security;
revoke all on table ${audit} from anon, authenticated, public;`;
}

function readFunctionSql(ctx: RlsSqlContext, entry: BreakGlassEntry): string {
  const fn = qualified(ctx, functionName(entry.resource));
  const audit = qualified(ctx, quoteIdent(BREAK_GLASS_AUDIT));
  const table = qualifiedTable(entry.table);
  const session = subjectClaimJsonSql(ctx, 'break_glass');
  const subject = subjectIdSql(ctx);
  return `-- ${entry.resource}: reads restricted rows through a checked, audited break-glass session
create or replace function ${fn}(p_permission text)
returns setof ${table}
language plpgsql
security definer
set search_path = ''
as $$
declare
  session jsonb := ${session};
begin
  if session is null
    or jsonb_typeof(session) <> 'object'
    or session ->> 'v' <> '1'
    or session ->> 'permission' <> p_permission
    or coalesce(session ->> 'reason', '') = ''
    or jsonb_typeof(session -> 'expiresAt') <> 'number'
    or (session ->> 'expiresAt')::numeric <= extract(epoch from now())
  then
    raise exception 'PermDock: no valid break-glass session for %', p_permission
      using errcode = '42501';
  end if;
  insert into ${audit} (subject, permission, purpose, reason)
  values (
    nullif((${subject})::text, ''),
    p_permission,
    session ->> 'purpose',
    session ->> 'reason'
  );
  return query select * from ${table};
end;
$$;
revoke execute on function ${fn}(text) from public, anon;
grant execute on function ${fn}(text) to authenticated;`;
}

/**
 * The `security definer` read path for every `breakGlass` grant: an audit
 * table and one `permdock_break_glass_<resource>(permission)` per resource
 * that checks a signed break-glass session, writes an audit row and returns
 * the table's rows (bypassing RLS as the definer). Empty when the policy has
 * no break-glass grant.
 */
export function breakGlassSql(
  ctx: RlsSqlContext,
  entries: readonly BreakGlassEntry[],
): string {
  if (entries.length === 0) {
    return '';
  }
  return [
    auditSql(ctx),
    ...entries.map((entry) => readFunctionSql(ctx, entry)),
  ].join('\n\n');
}
