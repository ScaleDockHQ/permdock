import type { Policy } from "../index.ts";
import type { RlsSqlContext } from "./rls-sql.ts";

import { scopeField } from "../core/tenancy.ts";
import { tableFor } from "./rls-compile.ts";
import {
  breakGlassHolder,
  breakGlassKey,
  collectGrants,
} from "./rls-grants.ts";
import { accessSql } from "./rls-helpers.ts";
import { qualified } from "./rls-shared.ts";
import {
  memberIdsHelper,
  quoteIdent,
  quoteLiteral,
  quoteTable,
  subjectClaimJsonSql,
  subjectIdSql,
} from "./rls-sql.ts";

/** The audit table every generated break-glass read writes to. Part of the SQL contract. */
const BREAK_GLASS_AUDIT = "permdock_break_glass_audit";

const IDENT = /^[a-z][a-z0-9_]*$/u;

/** One break-glass grant: a role must hold it where the row lives. */
type BreakGlassGrant = {
  readonly permission: string;
  /** `'global'`, a scope name, or `'anyone'` for a grant to no role. */
  readonly scope: string;
  /** The row's column for `scope`, or for an `'anyone'` grant the root scope's; `undefined` for `'global'`. */
  readonly column: string | undefined;
  /** For an `'anyone'` grant: the policy's root scope, or `undefined` when it declares none. */
  readonly root?: string;
};

/** One resource reachable by a break-glass read: its function reads this table. */
export type BreakGlassEntry = {
  readonly resource: string;
  readonly table: string;
  readonly grants: readonly BreakGlassGrant[];
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
  const byResource = new Map<string, BreakGlassGrant[]>();
  for (const item of collectGrants(policy)) {
    const { grant } = item;
    if (grant.breakGlass === undefined) {
      continue;
    }
    const holder = breakGlassHolder(item);
    const resource = grant.permission.resource;
    const grants = byResource.get(resource) ?? [];
    byResource.set(resource, grants);
    if (holder === undefined) {
      const root = policy.scopes[0];
      grants.push({
        permission: grant.permission.key,
        scope: "anyone",
        column:
          root === undefined
            ? undefined
            : scopeField(
                policy.resources.get(resource),
                root.name,
                policy.scopes,
              ),
        ...(root === undefined ? {} : { root: root.name }),
      });
      continue;
    }
    grants.push({
      permission: grant.permission.key,
      scope: holder.scope,
      column:
        holder.scope === "global"
          ? undefined
          : scopeField(
              policy.resources.get(resource),
              holder.scope,
              policy.scopes,
            ),
    });
  }
  return [...byResource].map(([resource, grants]) => ({
    resource,
    table: tableFor(resource, tables),
    grants,
  }));
}

/**
 * Rows the subject's roles reach for `p_permission`: a break-glass grant
 * lifts denies, never the tenant boundary. A grant to no role reads the rows
 * of the root scopes the subject is a member of, or every row when the
 * policy declares no scopes.
 */
function rowsFilter(ctx: RlsSqlContext, entry: BreakGlassEntry): string {
  const arms = entry.grants.flatMap((grant) => {
    const asked = `p_permission = ${quoteLiteral(grant.permission)}`;
    if (grant.scope === "anyone") {
      if (grant.root === undefined) {
        return [`(${asked})`];
      }
      return grant.column === undefined
        ? []
        : [
            `(${asked} and ${quoteIdent(grant.column)} in (select ${qualified(ctx, memberIdsHelper(grant.root))}()))`,
          ];
    }
    if (grant.scope !== "global" && grant.column === undefined) {
      return [];
    }
    return [
      `(${asked} and ${accessSql(ctx, grant.scope, breakGlassKey(grant.permission), grant.column)})`,
    ];
  });
  return arms.length === 0 ? "false" : [...new Set(arms)].join("\n    or ");
}

function functionName(resource: string): string {
  if (!IDENT.test(resource)) {
    throw new Error(`PermDock CLI: unsafe break-glass resource '${resource}'`);
  }
  return `permdock_break_glass_${resource}`;
}

function qualifiedTable(name: string): string {
  return quoteTable(name.includes(".") ? name : `public.${name}`);
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
  const session = subjectClaimJsonSql(ctx, "break_glass");
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
  return query select * from ${table}
  where ${rowsFilter(ctx, entry)};
end;
$$;
revoke execute on function ${fn}(text) from public, anon;
grant execute on function ${fn}(text) to authenticated;`;
}

/**
 * The `security definer` read path for every `breakGlass` grant: an audit
 * table and one `permdock_break_glass_<resource>(permission)` per resource
 * that checks a signed break-glass session, writes an audit row and returns
 * the rows in the scope instances where the subject holds a role with the
 * break-glass grant (bypassing the table's policies as the definer). Empty
 * when the policy has no break-glass grant.
 */
export function breakGlassSql(
  ctx: RlsSqlContext,
  entries: readonly BreakGlassEntry[],
): string {
  if (entries.length === 0) {
    return "";
  }
  return [
    auditSql(ctx),
    ...entries.map((entry) => readFunctionSql(ctx, entry)),
  ].join("\n\n");
}
