import type { Policy } from "../core/policy.ts";
import type { Scope } from "../core/scopes.ts";
import type {
  MembershipHolders,
  SqlMembershipSource,
} from "../supabase/sources.ts";
import type {
  RlsAssignmentTable,
  RlsMembershipTable,
  RoleThrough,
} from "./types.ts";

import { resolveScope, scopeChain } from "../core/scopes.ts";
import { findRole } from "../core/vocabulary.ts";
import { roleColumn } from "../supabase/roles.ts";
import {
  CUSTOM_ROLES,
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
  memberForSources,
  memberRoleOf,
  memberVia,
  quoteIdent,
  quoteLiteral,
  quoteTable,
  qualifiedTable,
  tenantTypeOf,
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
  const via = memberVia(table);
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

/** A membership source that is a table the ownership triggers can sit on. */
type HolderSource = {
  readonly table: string;
  readonly holders: MembershipHolders;
};

/**
 * The membership sources holding scope `name`: `undefined` when there are
 * none, `'not-tables'` when one of them carries no table to put a trigger on.
 */
function holderSources(
  ctx: RlsSqlContext,
  name: string,
): readonly HolderSource[] | "not-tables" | undefined {
  const sources = memberForSources(ctx, name);
  if (sources.length === 0) {
    return undefined;
  }
  const held: HolderSource[] = [];
  for (const source of sources) {
    if (source.sql.holders === undefined) {
      return "not-tables";
    }
    held.push({ table: source.sql.table, holders: source.sql.holders });
  }
  return held;
}

function indent(sql: string, by: string): string {
  return sql.replaceAll(/^/gmu, by);
}

/** Every source's rows of one instance, each compared with its own typed `v_key_<n>`. */
function sourceRowsOf(scope: string, sources: readonly HolderSource[]): string {
  return sources
    .map((source, index) =>
      indent(
        source.holders.rows(scope, { id: `v_key_${String(index)}` }),
        "        ",
      ),
    )
    .join("\n        union all\n");
}

function sourceKeys(sources: readonly HolderSource[]): {
  readonly declare: string;
  readonly assign: (value: string, by: string) => string;
} {
  return {
    declare: sources
      .map(
        (source, index) => `  v_key_${String(index)} ${source.holders.idType};`,
      )
      .join("\n"),
    assign: (value, by) =>
      sources
        .map((_, index) => `${by}v_key_${String(index)} := ${value};`)
        .join("\n"),
  };
}

function regclassOf(table: string): string {
  return `${quoteLiteral(membershipTable(table))}::regclass`;
}

function sourceTables(sources: readonly HolderSource[]): readonly string[] {
  return [...new Set(sources.map((source) => membershipTable(source.table)))];
}

/** `min` and `max` over membership sources: the same commit-time check as on a mapped table, counted over every source of the scope. */
function sourceHoldersTriggerSql(
  ctx: RlsSqlContext,
  scope: string,
  sources: readonly HolderSource[],
  counted: RlsOwnership["counted"],
): string {
  const fn = qualified(ctx, `${OWNERSHIP.holders}_${scope}`);
  const keys = sourceKeys(sources);
  const rows = sourceRowsOf(scope, sources);
  const collect = sources.map(
    (source) => `  if tg_relid = ${regclassOf(source.table)} then
    if tg_op in ('UPDATE', 'DELETE') then
      v_ids := v_ids || ${source.holders.id(scope, "old")};
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      v_ids := v_ids || ${source.holders.id(scope, "new")};
    end if;
  end if;`,
  );
  const checks = counted.map((rule) => {
    const filters = ["h.live", `h.role = ${quoteLiteral(rule.role)}`];
    const kind = roleKindSql(ctx, rule.role, "h.via");
    if (kind !== undefined) {
      filters.push(kind);
    }
    const lines = [
      `    select count(distinct h.user_id) into v_count
      from (
${rows}
      ) h
      where ${filters.join("\n        and ")};`,
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
  const triggers = sourceTables(sources).map(
    (
      table,
    ) => `drop trigger if exists ${objectName(OWNERSHIP.holders, scope)} on ${table};
create constraint trigger ${objectName(OWNERSHIP.holders, scope)}
  after insert or update or delete on ${table}
  deferrable initially deferred
  for each row execute function ${fn}();`,
  );
  return `-- ${scope}: holder counts (min / max) over the membership sources, checked at commit
create or replace function ${fn}()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids text[] := '{}';
  v_id text;
${keys.declare}
  v_total bigint;
  v_count bigint;
begin
${collect.join("\n")}
  foreach v_id in array v_ids loop
    continue when v_id is null;
${keys.assign("v_id", "    ")}
    select count(*) into v_total
      from (
${rows}
      ) h;
${checks.join("\n")}
  end loop;
  return null;
end;
$$;
${triggers.join("\n")}`;
}

function collectChangesSql(changed: string): string {
  return `      v_changes := v_changes || coalesce((select jsonb_agg(to_jsonb(c)) from (${changed}) c), '[]'::jsonb);`;
}

/** `transferOnly` over membership sources: each source table's statement triggers diff its transition tables, and the count after reads every source. */
function sourceTransferTriggerSql(
  ctx: RlsSqlContext,
  scope: string,
  sources: readonly HolderSource[],
  roles: readonly string[],
): string {
  const fn = qualified(ctx, `${OWNERSHIP.transferOnly}_${scope}`);
  const keys = sourceKeys(sources);
  const list = `array[${roles.map(quoteLiteral).join(", ")}]::text[]`;
  const kind = kindFilterSql(ctx, "h.role", "h.via");
  const changes = (source: HolderSource, from: string, delta: string): string =>
    `select h.id, h.role, ${delta} as delta from (${source.holders.rows(scope, { from }).replaceAll("\n", " ")}) h where h.role = any(${list})`;
  const branches = sources.map(
    (source) => `  if tg_relid = ${regclassOf(source.table)} then
    if tg_op in ('INSERT', 'UPDATE') then
${collectChangesSql(changes(source, "permdock_new", "1"))}
    end if;
    if tg_op in ('UPDATE', 'DELETE') then
${collectChangesSql(changes(source, "permdock_old", "-1"))}
    end if;
  end if;`,
  );
  const triggers = sourceTables(sources).flatMap((table) =>
    (["insert", "update", "delete"] as const).map((op) => {
      const name = quoteIdent(`${OWNERSHIP.transferOnly}_${scope}_${op}`);
      const referencing =
        op === "insert"
          ? "new table as permdock_new"
          : op === "delete"
            ? "old table as permdock_old"
            : "old table as permdock_old new table as permdock_new";
      return `drop trigger if exists ${name} on ${table};
create trigger ${name}
  after ${op} on ${table}
  referencing ${referencing}
  for each statement execute function ${fn}();`;
    }),
  );
  return `-- ${scope}: transfer-only roles (${roles.join(", ")}) keep their holder count per statement, over the membership sources
create or replace function ${fn}()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changes jsonb := '[]'::jsonb;
  v_change record;
  v_after bigint;
${keys.declare}
begin
${branches.join("\n")}
  for v_change in
    select x.id, x.role, sum(x.delta) as delta
    from jsonb_to_recordset(v_changes) x(id text, role text, delta bigint)
    group by x.id, x.role
  loop
    continue when v_change.delta = 0 or v_change.id is null;
${keys.assign("v_change.id", "    ")}
    select count(distinct h.user_id) into v_after
      from (
${sourceRowsOf(scope, sources)}
      ) h
      where h.live
        and h.role = v_change.role${kind === undefined ? "" : `\n        and ${kind}`};
    if v_after > 0 and v_after - v_change.delta > 0 then
      raise exception using
        errcode = '23514',
        message = 'permdock: ' || v_change.role || ${quoteLiteral(` in ${scope} `)} || v_change.id || ' moves only by transfer',
        hint = 'transfer-only';
    end if;
  end loop;
  return null;
end;
$$;
${triggers.join("\n")}`;
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
      const kind = kindFilterSql(ctx, role.sql, memberVia(table));
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
  const skipped = ctx.skipOwnershipTriggers;
  for (const { name } of ctx.scopes) {
    const counted = own.counted.filter((rule) => rule.scope === name);
    if (counted.length === 0) {
      continue;
    }
    if (skipped === "all" || skipped?.includes(name) === true) {
      chunks.push(
        `-- ${name}: rls.ownershipTriggers leaves out the triggers, so min, max and transferOnly are checked only by decideRoleChange`,
      );
      continue;
    }
    const transfer = counted
      .filter((rule) => rule.transferOnly)
      .map((rule) => rule.role);
    const mapped = scopeTable(ctx, name);
    if (mapped === undefined) {
      const sources = holderSources(ctx, name);
      if (sources === undefined) {
        chunks.push(
          `-- ${name}: no memberships table configured, so min, max and transferOnly are checked only by decideRoleChange`,
        );
      } else if (sources === "not-tables") {
        chunks.push(
          `-- ${name}: a membership source is not a table, so min, max and transferOnly are checked only by decideRoleChange`,
        );
      } else {
        chunks.push(sourceHoldersTriggerSql(ctx, name, sources, counted));
        if (transfer.length > 0) {
          chunks.push(sourceTransferTriggerSql(ctx, name, sources, transfer));
        }
      }
      continue;
    }
    chunks.push(
      holdersTriggerSql(ctx, name, mapped.table, mapped.column, counted),
    );
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

/** Objects `rls.assignments` adds. Names are part of the SQL contract. */
const ASSIGNMENTS = {
  custom: "permdock_can_assign_custom_role",
  trigger: "permdock_assignment",
} as const;

/** The client roles whose writes the assignment triggers check; any other role is a trusted path. */
const CLIENT_ROLES = ["anon", "anonymous", "authenticated"] as const;

/** One table whose rows assign a role at a scope instance. */
type AssignedTable = {
  readonly table: string;
  readonly scope: string;
  readonly id: string;
  readonly tenant: string;
  readonly role: RlsAssignmentTable["role"];
};

/** The mapped membership tables and `rls.assignments.tables`, deduplicated by table. */
function assignedTables(ctx: RlsSqlContext): readonly AssignedTable[] {
  const out: AssignedTable[] = [];
  for (const { name } of ctx.scopes) {
    const mapped = scopeTable(ctx, name);
    if (mapped === undefined) {
      continue;
    }
    out.push({
      table: mapped.table.table,
      scope: name,
      id: mapped.column,
      tenant: mapped.tenantColumn ?? mapped.column,
      role: mapped.table.role,
    });
  }
  for (const extra of ctx.assignments?.tables ?? []) {
    const scope = resolveScope(ctx.scopes, extra.scope);
    if (scope === undefined) {
      throw new Error(
        `PermDock CLI: rls.assignments.tables names scope '${extra.scope}', which the policy does not declare`,
      );
    }
    if (scope !== ctx.scopes[0]?.name && extra.tenant === undefined) {
      throw new Error(
        `PermDock CLI: rls.assignments.tables entry ${extra.table} assigns at ${scope}, below the first scope: name its tenant column`,
      );
    }
    out.push({
      table: extra.table,
      scope,
      id: extra.id,
      tenant: extra.tenant ?? extra.id,
      role: extra.role,
    });
  }
  return out;
}

function isRoleList(
  role: RlsAssignmentTable["role"],
): role is readonly (string | RoleThrough)[] {
  return Array.isArray(role);
}

/** The role keys a row variable holds, one scalar per role source. */
function rowRoles(entry: AssignedTable, row: string): readonly string[] {
  const parts: readonly (string | RoleThrough)[] = isRoleList(entry.role)
    ? entry.role
    : [entry.role];
  return parts.map(
    (part) =>
      roleColumn(part, qualifiedTable(entry.table), row, {
        label: `rls.assignments ${entry.table} role`,
        prefix: "PermDock CLI",
      }).lookup,
  );
}

/**
 * `permdock_can_assign_custom_role`: whether the signed-in caller may assign a
 * custom role of the tenant at the instance, by the checks the custom-role
 * write functions run on its stored definition.
 */
function canAssignCustomSql(ctx: RlsSqlContext): string {
  const tenantType = tenantTypeOf(ctx);
  const fn = qualified(ctx, ASSIGNMENTS.custom);
  const perms = qualified(ctx, CUSTOM_ROLES.permissions);
  const includes = qualified(ctx, CUSTOM_ROLES.includes);
  const guard = qualified(ctx, CUSTOM_ROLES.guard);
  const stored = `c.tenant_id = p_tenant and c.scope = p_scope and c.role = p_role and (c.scope_id is null or c.scope_id = p_scope_id)`;
  return `-- whether the caller may assign custom role p_role at instance p_scope_id: the custom-role write checks on its stored definition
create or replace function ${fn}(p_tenant ${tenantType}, p_scope text, p_scope_id text, p_role text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_scope_id text;
  v_found boolean := false;
begin
  select true, c.scope_id into v_found, v_scope_id
  from (
    select c.scope_id from ${perms} c where ${stored}
    union all
    select c.scope_id from ${includes} c where ${stored}
  ) c
  order by c.scope_id nulls first
  limit 1;
  if not coalesce(v_found, false) then
    return false;
  end if;
  perform ${guard}(p_tenant, p_scope, v_scope_id, p_role);
  return true;
exception
  when insufficient_privilege or invalid_parameter_value then
    return false;
end;
$$;
revoke execute on function ${fn}(${tenantType}, text, text, text) from public, anon;
grant execute on function ${fn}(${tenantType}, text, text, text) to authenticated;`;
}

/**
 * The assignment triggers (\`rls.assignments\`): before a client role inserts,
 * updates or deletes a row that assigns a role, every role the old and new
 * row hold must be one the caller may assign at that instance, by
 * \`permdock_can_assign\` for a declared role and
 * \`permdock_can_assign_custom_role\` for a custom one. The functions run as
 * the invoker, so \`current_user\` tells a client write from a trusted one.
 */
export function assignmentSql(ctx: RlsSqlContext): string {
  const own = ctx.ownership;
  if (
    ctx.assignments === undefined ||
    own === undefined ||
    own.assigns.length === 0
  ) {
    return "";
  }
  const canAssign = qualified(ctx, OWNERSHIP.canAssign);
  const custom = ctx.customRoles !== undefined && ctx.authorize === "database";
  const declared = ctx.customRoles?.declared;
  const tenantType = tenantTypeOf(ctx);
  const chunks: string[] = custom ? [canAssignCustomSql(ctx)] : [];
  const clients = `current_user::text = any(array[${CLIENT_ROLES.map(quoteLiteral).join(", ")}])`;
  for (const entry of assignedTables(ctx)) {
    const table = quoteTable(qualifiedTable(entry.table));
    const suffix = entry.table.replaceAll(/[^a-z0-9_]/gu, "_");
    const fn = qualified(ctx, quoteIdent(`${ASSIGNMENTS.trigger}_${suffix}`));
    const check = (row: string): string => {
      const id = `${row}.${quoteIdent(entry.id)}::text`;
      const tenant = `${row}.${quoteIdent(entry.tenant)}::${tenantType}`;
      const allowed =
        custom && declared !== undefined
          ? `case when v_role = any(${declaredArray(declared)}) then ${canAssign}(v_role, ${id}) else ${qualified(ctx, ASSIGNMENTS.custom)}(${tenant}, ${quoteLiteral(entry.scope)}, ${id}, v_role) end`
          : `${canAssign}(v_role, ${id})`;
      return `    foreach v_role in array array[${rowRoles(entry, row).join(", ")}]::text[] loop
      if v_role is not null and not coalesce(${allowed}, false) then
        raise exception using
          errcode = '42501',
          message = 'permdock: the caller may not assign ' || v_role || ' in ' || coalesce(${id}, 'null'),
          hint = 'not-assignable-by';
      end if;
    end loop;`;
    };
    chunks.push(`-- ${entry.table}: a client role may write only the ${entry.scope} roles it may assign
create or replace function ${fn}()
returns trigger
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_role text;
begin
  if not (${clients}) then
    return coalesce(new, old);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
${check("old")}
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
${check("new")}
  end if;
  return coalesce(new, old);
end;
$$;
revoke execute on function ${fn}() from public, anon, authenticated;
drop trigger if exists "permdock_assignment" on ${table};
create trigger "permdock_assignment"
  before insert or update or delete on ${table}
  for each row execute function ${fn}();`);
  }
  return `${chunks.join("\n\n")}\n`;
}

function declaredArray(values: readonly string[]): string {
  return values.length === 0
    ? `'{}'::text[]`
    : `array[${values.map(quoteLiteral).join(", ")}]::text[]`;
}
