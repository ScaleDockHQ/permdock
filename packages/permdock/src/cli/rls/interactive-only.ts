import type { Policy } from "../../index.ts";
import type { RlsSqlContext } from "../sql/context.ts";

import { listPermissions } from "../../index.ts";
import { qualified, quoteLiteral } from "../sql/quote.ts";
import { subjectClaimJsonSql, subjectClaimSql } from "../sql/subject.ts";

export const INTERACTIVE_ALLOWS = "permdock_interactive_allows";

export function interactiveOnlyKeys(
  policy: Policy,
): readonly string[] | undefined {
  const keys = listPermissions(policy.permissions)
    .filter((leaf) => leaf.meta.interactiveOnly === true)
    .map((leaf) => leaf.key)
    .toSorted();
  return keys.length === 0 ? undefined : keys;
}

function absent(json: string): string {
  return `(${json} is null or ${json} = 'null'::jsonb)`;
}

export function interactiveSessionSql(ctx: RlsSqlContext): string {
  const keyClaims = [...new Set(["api_key", ctx.apiKeys?.claim ?? "api_key"])];
  return `(${[
    ...keyClaims.map((claim) => absent(subjectClaimJsonSql(ctx, claim))),
    `coalesce(${subjectClaimSql(ctx, "client_id")}, '') = ''`,
    absent(subjectClaimJsonSql(ctx, "act")),
  ].join(" and ")})`;
}

export function interactiveAllowsCall(
  ctx: RlsSqlContext,
  grant: string,
): string {
  return `${qualified(ctx, INTERACTIVE_ALLOWS)}(${grant})`;
}

export function interactiveAllowsSql(
  ctx: RlsSqlContext,
  keys: readonly string[],
  anonExecute: boolean,
): string {
  const fn = qualified(ctx, INTERACTIVE_ALLOWS);
  const grants = anonExecute
    ? `revoke execute on function ${fn}(text) from public;
grant execute on function ${fn}(text) to anon, authenticated;`
    : `revoke execute on function ${fn}(text) from public, anon;
grant execute on function ${fn}(text) to authenticated;`;
  return `-- Interactive-only permissions: only a user's own session holds them; an API key, an OAuth client or an act chain never does, whatever its scopes
create or replace function ${fn}(p_grant text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return (
  select split_part(split_part(p_grant, '#', 1), '@', 1) <> all (array[${keys.map(quoteLiteral).join(", ")}]::text[])
    or ${interactiveSessionSql(ctx)}
  );
end;
$$;
${grants}`;
}

export function memoUserSql(ctx: RlsSqlContext, user: string): string {
  return ctx.interactiveOnly === undefined
    ? user
    : `(${user}::text || case when ${interactiveSessionSql(ctx)} then '' else '|delegated' end)`;
}
