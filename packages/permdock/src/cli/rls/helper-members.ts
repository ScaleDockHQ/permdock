import type { SqlMembershipSource } from "../../supabase/sources.ts";
import type { RlsSqlContext } from "../sql/context.ts";

import { scopeColumn } from "../../conditions/compile.ts";
import { activeMembershipSql } from "../sql/active.ts";
import {
  memberForHelper,
  memberForSources,
  memberIdsHelper,
  memberRoleOf,
  scopeSources,
  scopeTable,
} from "../sql/names.ts";
import { qualified, quoteLiteral, quoteQualified } from "../sql/quote.ts";
import { rootName, signedIn } from "../sql/shared.ts";
import {
  keyTenantSql,
  subjectClaimJsonSql,
  subjectIdSql,
} from "../sql/subject.ts";
import { serviceKeyMemberSql } from "./api-keys.ts";
import {
  type Body,
  claimKeptLines,
  claimTenant,
  disabledColumn,
  functionBody,
  memberColumn,
  sourceFilters,
  sourceIdOf,
  sourceRows,
  sourcesBodyOf,
  sourcesKeep,
  sqlBody,
} from "./helper-bodies.ts";
import { instancesActive, keyTenantLine, userActive } from "./helper-rows.ts";

/**
 * The body of `member_<scope>_ids()`: instances of `scope` the subject holds
 * a live membership of, with any role. Not narrowed to the active tenant, and
 * no cascade: a membership of a child scope is not one of its parent.
 */
function memberBody(ctx: RlsSqlContext, scope: string, type: string): Body {
  if (ctx.authorize !== "database") {
    return sqlBody(`  select distinct (m ->> 'id')::${type}
  from jsonb_array_elements(
    case jsonb_typeof(${membershipClaim(ctx)}) when 'array' then ${membershipClaim(ctx)} else '[]'::jsonb end
  ) m
  where ${signedIn(ctx)}
    and m ->> 'scope' = ${quoteLiteral(scope)}
    and m ->> 'id' is not null${keyTenantLine(ctx, scope, claimTenant(ctx, scope))}
    and jsonb_typeof(m -> 'roles') = 'array'
    and jsonb_array_length(m -> 'roles') > 0
    and case jsonb_typeof(m -> 'expiresAt')
      when 'number' then (m ->> 'expiresAt')::numeric > extract(epoch from now())
      else true
    end${[
      ...claimKeptLines(ctx, "    "),
      ...userActive(ctx, "    "),
      ...instancesActive(
        ctx,
        scope,
        (name) =>
          name === scope
            ? `m ->> 'id'`
            : `m -> 'within' ->> ${quoteLiteral(name)}`,
        "    ",
      ),
    ]
      .map((line) => `\n${line}`)
      .join("")}`);
  }
  return memberRowsBody(
    ctx,
    scope,
    type,
    subjectIdSql(ctx),
    scopeSources(ctx, scope),
    true,
  );
}

/**
 * The membership rows of `user` for `scope`, from the sources or else the
 * mapped table, with the same expiry and suspension filters either way.
 */
function memberRowsBody(
  ctx: RlsSqlContext,
  scope: string,
  type: string,
  user: string,
  sources: readonly SqlMembershipSource[],
  keyed = false,
): Body {
  if (sources.length > 0) {
    const narrow = keyed
      ? keyTenantLine(ctx, scope, sourceIdOf(scope)(rootName(ctx)))
      : "";
    return sourcesBodyOf(
      `  select distinct (ms.id)::${type}
  from (
${sourceRows(sources)}
  ) ms
  where ${signedIn(ctx, user)}
    and ms.scope = ${quoteLiteral(scope)}
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0${narrow}${sourceFilters(ctx, scope, user, undefined, sourcesKeep(sources))}`,
      sources,
      user,
    );
  }
  const mapped = scopeTable(ctx, scope);
  if (mapped === undefined) {
    return sqlBody(
      `  select null::${type} where false -- no ${scope} memberships table configured`,
    );
  }
  const { table, column, tenantColumn } = mapped;
  const role = memberRoleOf(table, "m", "  ");
  const lines = [
    `  select distinct ${memberColumn(column)}::${type}`,
    `  from ${quoteQualified(table.table)} m${role.join}`,
    `  where ${memberColumn(table.user)} = ${user}`,
    `    and ${role.through === undefined && !role.lateral ? memberColumn(role.column) : role.sql} is not null`,
  ];
  const narrow = keyed
    ? keyTenantSql(
        ctx,
        tenantColumn === undefined ? undefined : memberColumn(tenantColumn),
      )
    : undefined;
  if (narrow !== undefined) {
    lines.push(`    and ${narrow}`);
  }
  if (table.expiresAt !== undefined) {
    const expires = memberColumn(table.expiresAt);
    lines.push(`    and (${expires} is null or ${expires} > now())`);
  }
  lines.push(
    ...activeMembershipSql(ctx, disabledColumn(table), undefined).map(
      (part) => `    and ${part}`,
    ),
    ...userActive(ctx, "    ", user),
    ...instancesActive(
      ctx,
      scope,
      (name) => {
        const held = scopeColumn(table, ctx.scopes, name);
        return held === undefined ? undefined : memberColumn(held);
      },
      "    ",
    ),
  );
  return sqlBody(lines.join("\n"));
}

function membershipClaim(ctx: RlsSqlContext): string {
  const raw = subjectClaimJsonSql(ctx, "memberships");
  return ctx.dialect === "supabase"
    ? `coalesce(${raw}, (select auth.jwt()) -> 'app_metadata' -> 'memberships')`
    : raw;
}

export function memberFunction(
  ctx: RlsSqlContext,
  scope: string,
  type: string,
  anonExecute: boolean,
): string {
  const fn = qualified(ctx, memberIdsHelper(scope));
  const body = memberBody(ctx, scope, type);
  const keys = ctx.apiKeys;
  const keyed =
    keys === undefined || scope !== rootName(ctx)
      ? body
      : {
          sql: `${body.sql}\n  union\n${serviceKeyMemberSql(ctx, keys, scope, type)}`,
          vars: body.vars,
        };
  const grants = anonExecute
    ? `revoke execute on function ${fn}() from public;
grant execute on function ${fn}() to anon, authenticated;`
    : `revoke execute on function ${fn}() from public, anon;
grant execute on function ${fn}() to authenticated;`;
  return `create or replace function ${fn}()
returns setof ${type}
${functionBody(keyed)}
${grants}`;
}

/**
 * `member_<scope>_ids_for(p_user uuid)`: `member_<scope>_ids()` for a user the
 * caller names, read from the membership sources (or the mapped table) in
 * either mode, so a token hook can call it before any claim exists. Naming
 * the user is why no client role may execute it; the hook's grants give
 * `supabase_auth_admin` execute.
 */
export function memberForFunction(
  ctx: RlsSqlContext,
  scope: string,
  type: string,
): string {
  const fn = qualified(ctx, memberForHelper(scope));
  const body = memberRowsBody(
    ctx,
    scope,
    type,
    "p_user",
    memberForSources(ctx, scope),
  );
  return `create or replace function ${fn}(p_user uuid)
returns setof ${type}
${functionBody(body)}
revoke execute on function ${fn}(uuid) from public, anon, authenticated;`;
}
