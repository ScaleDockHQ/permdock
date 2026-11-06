import type { RlsSqlContext } from "../sql/context.ts";
import type { RlsActiveRow } from "../types.ts";

import { qualifySqlTable } from "../../core/sql.ts";
import {
  helperSchema,
  qualified,
  quoteIdent,
  quoteTable,
} from "../sql/quote.ts";
import { CUSTOM_ROLES } from "../sql/shared.ts";
import { memoizes } from "./helper-bodies.ts";

const BUMP = "permdock_bump_memo_generation";
const TRIGGER = "permdock_memo_generation";

type Target = {
  readonly table: string;
  readonly columns: Set<string> | undefined;
};

function add(
  targets: Map<string, Target>,
  table: string,
  columns: readonly string[] = [],
): void {
  const key = qualifySqlTable(table);
  const existing = targets.get(key);
  if (existing === undefined) {
    targets.set(key, {
      table,
      columns: columns.length === 0 ? undefined : new Set(columns),
    });
    return;
  }
  if (existing.columns === undefined || columns.length === 0) {
    targets.set(key, { table: existing.table, columns: undefined });
    return;
  }
  for (const column of columns) {
    existing.columns.add(column);
  }
}

function suspensionTargets(
  targets: Map<string, Target>,
  row: RlsActiveRow | undefined,
): void {
  if (row === undefined) {
    return;
  }
  const columns = [
    ...(row.disabledAt === undefined ? [] : [row.disabledAt]),
    ...(row.status === undefined ? [] : [row.status]),
  ];
  add(targets, row.table, columns);
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const READ = new RegExp(
  String.raw`(?<!\bdistinct\s+)(?<!\bextract\s*\([^()]*)\b(?:from|join)\s+(${IDENT})\.(${IDENT})(?![\w$]|\s*[.(])`,
  "gu",
);
const SYSTEM = new Set(["auth", "pg_catalog", "information_schema"]);

function unquote(name: string): string {
  return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name;
}

export function readTables(sql: string): readonly string[] {
  const out = new Set<string>();
  for (const [, schema = "", table = ""] of sql.matchAll(READ)) {
    const name = unquote(schema);
    if (!SYSTEM.has(name)) {
      out.add(`${name}.${unquote(table)}`);
    }
  }
  return [...out];
}

function memoTargets(
  ctx: RlsSqlContext,
  reads: string,
): ReadonlyMap<string, Target> {
  const schema = helperSchema(ctx);
  const targets = new Map<string, Target>();
  add(targets, `${schema}.role_permissions`);
  if (ctx.customRoles !== undefined) {
    add(targets, `${schema}.${CUSTOM_ROLES.permissions}`);
    add(targets, `${schema}.${CUSTOM_ROLES.includes}`);
    const roles = ctx.customRoles.table;
    if (roles !== undefined) {
      add(targets, roles.table, [
        roles.key,
        ...(roles.tenant === undefined ? [] : [roles.tenant]),
        ...(roles.scope === undefined ? [] : [roles.scope]),
      ]);
    }
  }
  suspensionTargets(targets, ctx.suspension?.users);
  for (const row of Object.values(ctx.suspension?.scopes ?? {})) {
    suspensionTargets(targets, row);
  }
  for (const table of readTables(reads)) {
    if (!targets.has(qualifySqlTable(table))) {
      add(targets, table);
    }
  }
  if (ctx.seeds === "view") {
    targets.delete(qualifySqlTable(`${schema}.role_permissions`));
  }
  return targets;
}

function triggersSql(ctx: RlsSqlContext, targets: Iterable<Target>): string {
  const trigger = qualified(ctx, TRIGGER);
  return [...targets]
    .map(({ table, columns }) => {
      const target = quoteTable(qualifySqlTable(table));
      const update =
        columns === undefined
          ? "update"
          : `update of ${[...columns].map((column) => quoteIdent(column)).join(", ")}`;
      return `drop trigger if exists ${quoteIdent(TRIGGER)} on ${target};
create trigger ${quoteIdent(TRIGGER)}
  after insert or ${update} or delete on ${target}
  for each statement execute function ${trigger}();
drop trigger if exists ${quoteIdent(`${TRIGGER}_truncate`)} on ${target};
create trigger ${quoteIdent(`${TRIGGER}_truncate`)}
  after truncate on ${target}
  for each statement execute function ${trigger}();`;
    })
    .join("\n");
}

/**
 * The triggers that invalidate the memo when a write changes permitted ids
 * inside the statement: the permission map, a custom role's grants, a suspended
 * user or scope, and every table `reads` (the memoized helper bodies) selects
 * from, such as the membership sources and the global roles. The hook's version
 * triggers call the same bump.
 */
export function memoGenerationSql(ctx: RlsSqlContext, reads = ""): string {
  if (!memoizes(ctx)) {
    return "";
  }
  const bump = qualified(ctx, BUMP);
  const trigger = qualified(ctx, TRIGGER);
  return `-- a permission, custom-role, suspension or membership write changes permitted ids inside the statement
create or replace function ${bump}()
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select set_config(
    'permdock.m.gen',
    (coalesce(nullif(current_setting('permdock.m.gen', true), ''), '0')::int + 1)::text,
    true
  )
$$;
revoke execute on function ${bump}() from public, anon, authenticated;

create or replace function ${trigger}()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform ${bump}();
  return null;
end;
$$;
revoke execute on function ${trigger}() from public, anon, authenticated;
${triggersSql(ctx, memoTargets(ctx, reads).values())}`;
}

export function memoReadTriggersSql(
  ctx: RlsSqlContext,
  reads: string,
  covered: string,
): string {
  const done = memoTargets(ctx, covered);
  const targets = new Map<string, Target>();
  for (const table of readTables(reads)) {
    if (!done.has(qualifySqlTable(table))) {
      add(targets, table);
    }
  }
  return targets.size === 0 ? "" : triggersSql(ctx, targets.values());
}
