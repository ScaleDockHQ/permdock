import type {
  MembershipHolders,
  SqlMembershipSource,
} from "../../supabase/sources.ts";
import type { RlsOwnership, RlsSqlContext } from "../sql/context.ts";

import { memberForSources } from "../sql/names.ts";
import {
  qualified,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "../sql/quote.ts";
import { kindFilterSql, roleKindSql } from "../sql/subject.ts";
import { OWNERSHIP } from "./ownership-names.ts";
import { objectName } from "./ownership-triggers.ts";

/** A membership source that is a table the ownership triggers can sit on. */
type HolderSource = {
  readonly table: string;
  readonly holders: MembershipHolders;
};

/**
 * The membership sources holding scope `name`: `undefined` when there are none,
 * `'not-tables'` when one of them carries no table to put a trigger on.
 */
export function holderSources(
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

/**
 * Every source's rows of one instance, each compared with its own typed
 * `v_key_<n>`.
 */
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
  return `${quoteLiteral(quoteQualified(table))}::regclass`;
}

function sourceTables(sources: readonly HolderSource[]): readonly string[] {
  return [...new Set(sources.map((source) => quoteQualified(source.table)))];
}

/**
 * `min` and `max` over membership sources: the same commit-time check as on a
 * mapped table, counted over every source of the scope.
 */
export function sourceHoldersTriggerSql(
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

/**
 * `transferOnly` over membership sources: each source table's statement
 * triggers diff its transition tables, and the count after reads every source.
 */
export function sourceTransferTriggerSql(
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

export function pairsSql(pairs: RlsOwnership["assigns"]): string {
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
export function sourceRowsSql(
  sources: readonly SqlMembershipSource[],
  user: (source: SqlMembershipSource) => string,
): string {
  const keep = sources.some((source) => source.sql.keeps);
  return sources
    .map((source) =>
      source.sql.select(user(source), keep).replaceAll(/^/gmu, "        "),
    )
    .join("\n        union all\n");
}
