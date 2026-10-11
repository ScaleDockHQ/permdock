import type { RlsSqlContext } from "../sql/context.ts";

import { qualified, quoteIdent, quoteLiteral } from "../sql/quote.ts";
import { subjectClaimJsonSql } from "../sql/subject.ts";

/** The helper `--capabilities` adds: ids of one resource a link capability claim reaches. Part of the SQL contract. */
const CAPABILITIES = {
  ids: "permdock_capability_ids",
} as const;

/**
 * The `anon` branch access for a resource-scoped grant reached through a link
 * capability: the row's `field` holds an id the capability claim names for
 * `resource`, `role` and `permission`. Uncorrelated, so it runs once per
 * statement; the column is compared as text because the claim holds text.
 */
export function capabilityAccessSql(
  ctx: RlsSqlContext,
  field: string,
  resource: string,
  role: string,
  permission: string,
): string {
  const args = [resource, role, permission].map(quoteLiteral).join(", ");
  return `${quoteIdent(field)}::text in (select ${qualified(ctx, CAPABILITIES.ids)}(${args}))`;
}

export function capabilitiesSql(ctx: RlsSqlContext): string {
  if (ctx.capabilities !== true) {
    return "";
  }
  const fn = qualified(ctx, CAPABILITIES.ids);
  const claim = subjectClaimJsonSql(ctx, "capability");
  return `-- link capabilities: the capability claim exchangeCapability mints (role anon, short-lived)
create or replace function ${fn}(p_resource text, p_role text, p_permission text)
returns setof text
language sql
stable
set search_path = ''
as $$
  select c -> 'on' ->> 'id'
  from (select ${claim} as c) capability
  where jsonb_typeof(c) = 'object'
    and c ->> 'v' = '1'
    and c ->> 'holder' = 'link'
    and c -> 'on' ->> 'resource' = p_resource
    and jsonb_typeof(c -> 'roles') = 'array'
    and c -> 'roles' @> jsonb_build_array(p_role)
    and (c -> 'permissions' is null or c -> 'permissions' @> jsonb_build_array(p_permission))
    and jsonb_typeof(c -> 'expiresAt') = 'number'
    and (c ->> 'expiresAt')::numeric > extract(epoch from now())
$$;
revoke execute on function ${fn}(text, text, text) from public;
grant execute on function ${fn}(text, text, text) to anon, authenticated;`;
}
