import type { RlsOwnership, RlsSqlContext } from "../sql/context.ts";
import type { RlsMembershipTable } from "../types.ts";

import { memberRoleOf } from "../sql/names.ts";
import {
  qualified,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "../sql/quote.ts";
import { kindFilterSql, memberVia, roleKindSql } from "../sql/subject.ts";
import { disabledColumn, memberColumn } from "./helper-bodies.ts";
import { OWNERSHIP } from "./ownership-names.ts";

export function objectName(prefix: string, scope: string): string {
  return quoteIdent(`${prefix}_${scope}`);
}

/**
 * Live holders of `roleExpr` in instance `idExpr`, with the same kind and
 * expiry rules as the helpers.
 */
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
  const disabled = disabledColumn(table);
  if (disabled !== undefined) {
    filters.push(`${disabled} is null`);
  }
  const via = memberVia(table);
  const kind =
    typeof role === "string"
      ? roleKindSql(ctx, role, via)
      : kindFilterSql(ctx, roleExpr, via);
  if (kind !== undefined) {
    filters.push(kind);
  }
  return `select count(distinct m.${quoteIdent(table.user)}) into ${into}
      from ${quoteQualified(table.table)} m${held.join}
      where ${filters.join("\n        and ")}`;
}

/**
 * `min` and `max` as a deferred constraint trigger: checked at commit, so a
 * transfer (demote one holder, promote another) passes in one transaction. An
 * instance with no memberships left is being torn down and skips `min`.
 */
export function holdersTriggerSql(
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
      `    select count(*) into v_total from ${quoteQualified(table.table)} m where m.${col} = v_key;`,
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
  v_key ${quoteQualified(table.table)}.${col}%type;
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
drop trigger if exists ${objectName(OWNERSHIP.holders, scope)} on ${quoteQualified(table.table)};
create constraint trigger ${objectName(OWNERSHIP.holders, scope)}
  after insert or update or delete on ${quoteQualified(table.table)}
  deferrable initially deferred
  for each row execute function ${fn}();`;
}

/**
 * `transferOnly` as statement triggers over transition tables: a statement that
 * changes a role's holder count in an instance that had holders before and
 * still has some after is refused. Creating the first holder and removing the
 * last (which `min` guards) are not transfers.
 */
export function transferTriggerSql(
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
  const target = quoteQualified(table.table);
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
