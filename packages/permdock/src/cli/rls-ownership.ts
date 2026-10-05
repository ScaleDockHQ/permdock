import type { Policy } from "../core/policy.ts";
import type { Scope } from "../core/scopes.ts";
import type { SqlMembershipSource } from "../supabase/sources.ts";
import type { RlsMembershipTable } from "./types.ts";

import { resolveScope, scopeChain } from "../core/scopes.ts";
import { findRole } from "../core/vocabulary.ts";
import {
  globalRoleRows,
  memberColumn,
  membershipRows,
  membershipTable,
  qualified,
  roleRows,
  signedIn,
  sourceFilters,
} from "./rls-helpers.ts";
import {
  type RlsOwnership,
  type RlsSqlContext,
  globalKindFilterSql,
  kindFilterSql,
  memberRoleOf,
  memberViaSql,
  quoteIdent,
  quoteLiteral,
  roleKindSql,
  scopeSources,
  scopeTable,
  subjectIdSql,
} from "./rls-sql.ts";

/** Objects the ownership rules add next to the helpers. Names are part of the SQL contract. */
const OWNERSHIP = {
  canAssign: "permdock_can_assign",
  holders: "permdock_holders",
  transferOnly: "permdock_transfer_only",
} as const;

function roleScope(
  policy: Policy,
  scopes: readonly Scope[],
  name: string,
): string | undefined {
  const on =
    policy.rolesByName.get(name)?.on ??
    findRole(policy.vocabulary.roles, name)?.on;
  return typeof on === "string" ? resolveScope(scopes, on) : undefined;
}

/** The rules `rls generate` enforces; `undefined` when no role declares one. */
export function ownershipRules(
  policy: Policy,
  scopes: readonly Scope[],
): RlsOwnership | undefined {
  const kinds: Record<string, readonly string[]> = {};
  const assigns: RlsOwnership["assigns"][number][] = [];
  const counted: RlsOwnership["counted"][number][] = [];
  for (const binding of policy.roles) {
    const scope = roleScope(policy, scopes, binding.name);
    if (binding.for !== undefined) {
      kinds[binding.name] = binding.for;
    }
    const assigner =
      scope ?? (binding.on === undefined ? ("global" as const) : undefined);
    for (const target of binding.assigns ?? []) {
      const at = roleScope(policy, scopes, target);
      if (
        assigner !== undefined &&
        at !== undefined &&
        (assigner === "global" || scopeChain(scopes, at).includes(assigner))
      ) {
        assigns.push({ assigner: binding.name, scope: assigner, role: target });
      }
    }
    const min = binding.min ?? 0;
    const transferOnly = binding.transferOnly === true;
    if (
      scope !== undefined &&
      (min > 0 || binding.max !== undefined || transferOnly)
    ) {
      counted.push(
        binding.max === undefined
          ? { role: binding.name, scope, min, transferOnly }
          : { role: binding.name, scope, min, max: binding.max, transferOnly },
      );
    }
  }
  if (
    Object.keys(kinds).length === 0 &&
    assigns.length === 0 &&
    counted.length === 0
  ) {
    return undefined;
  }
  return { kinds, assigns, counted };
}

function objectName(prefix: string, scope: string): string {
  return quoteIdent(`${prefix}_${scope}`);
}

/** Live holders of `roleExpr` in instance `idExpr`, with the same kind and expiry rules as the helpers. */
function holdersSql(
  ctx: RlsSqlContext,
  table: RlsMembershipTable,
  column: string,
  idExpr: string,
  role: string | { readonly expr: string },
  into: string,
): string {
  const roleExpr = typeof role === "string" ? quoteLiteral(role) : role.expr;
  const held = memberRoleOf(table, "m", "      ");
  const filters = [
    `m.${quoteIdent(column)} = ${idExpr}`,
    `${held.sql} = ${roleExpr}`,
  ];
  if (table.expiresAt !== undefined) {
    const expires = memberColumn(table.expiresAt);
    filters.push(`(${expires} is null or ${expires} > now())`);
  }
  const via = memberViaSql(table);
  const kind =
    typeof role === "string"
      ? roleKindSql(ctx, role, via)
      : kindFilterSql(ctx, roleExpr, via);
  if (kind !== undefined) {
    filters.push(kind);
  }
  return `select count(distinct m.${quoteIdent(table.user)}) into ${into}
      from ${membershipTable(table.table)} m${held.join}
      where ${filters.join("\n        and ")}`;
}

/**
 * `min` and `max` as a deferred constraint trigger: checked at commit, so a
 * transfer (demote one holder, promote another) passes in one transaction. An
 * instance with no memberships left is being torn down and skips `min`.
 */
function holdersTriggerSql(
  ctx: RlsSqlContext,
  scope: string,
  table: RlsMembershipTable,
  column: string,
  counted: RlsOwnership["counted"],
): string {
  const fn = qualified(ctx, `${OWNERSHIP.holders}_${scope}`);
  const col = quoteIdent(column);
  const checks = counted.map((rule) => {
    const lines = [
      `    select count(*) into v_total from ${membershipTable(table.table)} m where m.${col} = v_key;`,
      `    ${holdersSql(ctx, table, column, "v_key", rule.role, "v_count")};`,
    ];
    if (rule.min > 0) {
      lines.push(`    if v_total > 0 and v_count < ${String(rule.min)} then
      raise exception using
        errcode = '23514',
        message = ${quoteLiteral(`permdock: ${scope} `)} || v_id || ${quoteLiteral(` keeps at least ${String(rule.min)} ${rule.role}`)},
        hint = 'last-holder';
    end if;`);
    }
    if (rule.max !== undefined) {
      lines.push(`    if v_count > ${String(rule.max)} then
      raise exception using
        errcode = '23514',
        message = ${quoteLiteral(`permdock: ${scope} `)} || v_id || ${quoteLiteral(` has at most ${String(rule.max)} ${rule.role}`)},
        hint = 'max-holders';
    end if;`);
    }
    return lines.join("\n");
  });
  return `-- ${scope}: holder counts (min / max), checked at commit
create or replace function ${fn}()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids text[] := '{}';
  v_id text;
  v_key ${membershipTable(table.table)}.${col}%type;
  v_total bigint;
  v_count bigint;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_ids := v_ids || old.${col}::text;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_ids := v_ids || new.${col}::text;
  end if;
  foreach v_id in array v_ids loop
    continue when v_id is null;
    v_key := v_id;
${checks.join("\n")}
  end loop;
  return null;
end;
$$;
drop trigger if exists ${objectName(OWNERSHIP.holders, scope)} on ${membershipTable(table.table)};
create constraint trigger ${objectName(OWNERSHIP.holders, scope)}
  after insert or update or delete on ${membershipTable(table.table)}
  deferrable initially deferred
  for each row execute function ${fn}();`;
}

/**
 * `transferOnly` as statement triggers over transition tables: a statement
 * that changes a role's holder count in an instance that had holders before
 * and still has some after is refused. Creating the first holder and removing
 * the last (which `min` guards) are not transfers.
 */
function transferTriggerSql(
  ctx: RlsSqlContext,
  scope: string,
  table: RlsMembershipTable,
  column: string,
  roles: readonly string[],
): string {
  const fn = qualified(ctx, `${OWNERSHIP.transferOnly}_${scope}`);
  const col = quoteIdent(column);
  const list = `array[${roles.map(quoteLiteral).join(", ")}]::text[]`;
  const rows = (alias: string, source: string, delta: string): string => {
    const role = memberRoleOf(table, alias);
    return `select ${alias}.${col} as id, ${role.sql} as role, ${delta} as delta from ${source} ${alias}${role.join} where ${role.sql} = any(${list})`;
  };
  const loop = (source: string): string => `    for v_change in
      select c.id, c.role, sum(c.delta) as delta
      from (${source}) c
      group by c.id, c.role
    loop
      continue when v_change.delta = 0 or v_change.id is null;
      ${holdersSql(ctx, table, column, "v_change.id", { expr: "v_change.role" }, "v_after")};
      if v_after > 0 and v_after - v_change.delta > 0 then
        raise exception using
          errcode = '23514',
          message = 'permdock: ' || v_change.role || ${quoteLiteral(` in ${scope} `)} || v_change.id || ' moves only by transfer',
          hint = 'transfer-only';
      end if;
    end loop;`;
  const inserted = rows("n", "permdock_new", "1");
  const deleted = rows("o", "permdock_old", "-1");
  const target = membershipTable(table.table);
  const trigger = (op: "insert" | "update" | "delete"): string => {
    const name = quoteIdent(`${OWNERSHIP.transferOnly}_${scope}_${op}`);
    const referencing =
      op === "insert"
        ? "new table as permdock_new"
        : op === "delete"
          ? "old table as permdock_old"
          : "old table as permdock_old new table as permdock_new";
    return `drop trigger if exists ${name} on ${target};
create trigger ${name}
  after ${op} on ${target}
  referencing ${referencing}
  for each statement execute function ${fn}();`;
  };
  return `-- ${scope}: transfer-only roles (${roles.join(", ")}) keep their holder count per statement
create or replace function ${fn}()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_change record;
  v_after bigint;
begin
  if tg_op = 'INSERT' then
${loop(inserted)}
  elsif tg_op = 'DELETE' then
${loop(deleted)}
  else
${loop(`${inserted} union all ${deleted}`)}
  end if;
  return null;
end;
$$;
${trigger("insert")}
${trigger("update")}
${trigger("delete")}`;
}

function pairsSql(pairs: RlsOwnership["assigns"]): string {
  return `values ${pairs
    .map(
      (pair) => `(${quoteLiteral(pair.assigner)}, ${quoteLiteral(pair.role)})`,
    )
    .join(", ")}`;
}

/**
 * Membership rows of the membership sources for scope `name`, each source's
 * `select` comparing its user column with a variable `user` names.
 */
function sourceRowsSql(
  sources: readonly SqlMembershipSource[],
  user: (source: SqlMembershipSource) => string,
): string {
  return sources
    .map((source) =>
      source.sql.select(user(source)).replaceAll(/^/gmu, "        "),
    )
    .join("\n        union all\n");
}

/** Whether the signed-in user holds, in instance `p_scope_id`, a role whose `assigns` lists `p_role`. */
function canAssignSql(ctx: RlsSqlContext, own: RlsOwnership): string {
  const fn = qualified(ctx, OWNERSHIP.canAssign);
  const parts: string[] = [];
  const used: SqlMembershipSource[] = [];
  const userOf = (source: SqlMembershipSource): string => {
    const index = used.includes(source)
      ? used.indexOf(source)
      : used.push(source) - 1;
    return `v_user_${String(index)}`;
  };
  const global = own.assigns.filter((pair) => pair.scope === "global");
  if (global.length > 0) {
    if (ctx.authorize === "database") {
      const ur = globalRoleRows(ctx);
      const kind = globalKindFilterSql(ctx, ur.roleSql);
      parts.push(`exists (
      select 1 from ${ur.from}
      where ${ur.userSql} = ${subjectIdSql(ctx)}
        and (${ur.roleSql}, p_role) in (${pairsSql(global)})${kind === undefined ? "" : `\n        and ${kind}`}
    )`);
    } else {
      const kind = globalKindFilterSql(ctx, "r.role");
      parts.push(`exists (
      select 1 from ${roleRows(ctx)}
      where (r.role, p_role) in (${pairsSql(global)})${kind === undefined ? "" : `\n        and ${kind}`}
    )`);
    }
  }
  for (const { name } of ctx.scopes) {
    const pairs = own.assigns.filter((pair) => pair.scope === name);
    if (pairs.length === 0) {
      continue;
    }
    const sources = scopeSources(ctx, name);
    if (sources.length > 0) {
      const kind = kindFilterSql(ctx, "r.role", "ms.via");
      parts.push(`exists (
      select 1
      from (
${sourceRowsSql(sources, userOf)}
      ) ms
      cross join lateral jsonb_array_elements_text(
        case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
      ) r(role)
      where ms.scope = ${quoteLiteral(name)}
        and ms.id = p_scope_id
        and (r.role, p_role) in (${pairsSql(pairs)})${kind === undefined ? "" : `\n        and ${kind}`}${sourceFilters(ctx, name).replaceAll("\n    and ", "\n        and ")}
    )`);
      continue;
    }
    if (ctx.authorize === "database") {
      const mapped = scopeTable(ctx, name);
      if (mapped === undefined) {
        continue;
      }
      const { table, column } = mapped;
      const role = memberRoleOf(table, "m", "      ");
      const filters = [
        `${memberColumn(table.user)} = ${subjectIdSql(ctx)}`,
        `${memberColumn(column)}::text = p_scope_id`,
        `(${role.sql}, p_role) in (${pairsSql(pairs)})`,
      ];
      if (table.expiresAt !== undefined) {
        const expires = memberColumn(table.expiresAt);
        filters.push(`(${expires} is null or ${expires} > now())`);
      }
      const kind = kindFilterSql(ctx, role.sql, memberViaSql(table));
      if (kind !== undefined) {
        filters.push(kind);
      }
      parts.push(`exists (
      select 1 from ${membershipTable(table.table)} m${role.join}
      where ${filters.join("\n        and ")}
    )`);
    } else {
      const kind = kindFilterSql(ctx, "r.role", "m ->> 'via'");
      parts.push(`exists (
      select 1 from ${membershipRows(ctx)}
      where m ->> 'scope' = ${quoteLiteral(name)}
        and m ->> 'id' = p_scope_id
        and (r.role, p_role) in (${pairsSql(pairs)})
        and case jsonb_typeof(m -> 'expiresAt')
          when 'number' then (m ->> 'expiresAt')::numeric > extract(epoch from now())
          else true
        end${kind === undefined ? "" : `\n        and ${kind}`}
    )`);
    }
  }
  const body = parts.length === 0 ? "false" : parts.join("\n    or ");
  const language =
    used.length === 0
      ? `language sql
stable
security definer
set search_path = ''
as $$
  select ${signedIn(ctx)} and (
    ${body}
  )
$$;`
      : `language plpgsql
stable
security definer
set search_path = ''
as $$
declare
${used.map((source, index) => `  v_user_${String(index)} ${source.sql.userType} := ${subjectIdSql(ctx)};`).join("\n")}
begin
  return ${signedIn(ctx)} and (
    ${body}
  );
end;
$$;`;
  return `-- who may assign: a held role whose assigns lists p_role, in instance p_scope_id (its scope or an ancestor's)
create or replace function ${fn}(p_role text, p_scope_id text)
returns boolean
${language}
revoke execute on function ${fn}(text, text) from public, anon;
grant execute on function ${fn}(text, text) to authenticated;`;
}

/**
 * The ownership objects: holder-count and transfer-only triggers on each
 * scope's membership table, and `permdock_can_assign` for the application's
 * own policies on those tables. Empty when no role declares a rule.
 */
export function ownershipSql(ctx: RlsSqlContext): string {
  const own = ctx.ownership;
  if (own === undefined) {
    return "";
  }
  const chunks: string[] = [];
  for (const { name } of ctx.scopes) {
    const counted = own.counted.filter((rule) => rule.scope === name);
    if (counted.length === 0) {
      continue;
    }
    const mapped = scopeTable(ctx, name);
    if (mapped === undefined) {
      chunks.push(
        `-- ${name}: no memberships table configured, so min, max and transferOnly are checked only by decideRoleChange`,
      );
      continue;
    }
    chunks.push(
      holdersTriggerSql(ctx, name, mapped.table, mapped.column, counted),
    );
    const transfer = counted
      .filter((rule) => rule.transferOnly)
      .map((rule) => rule.role);
    if (transfer.length > 0) {
      chunks.push(
        transferTriggerSql(ctx, name, mapped.table, mapped.column, transfer),
      );
    }
  }
  if (own.assigns.length > 0) {
    chunks.push(canAssignSql(ctx, own));
  }
  return chunks.length === 0 ? "" : `${chunks.join("\n\n")}\n`;
}
