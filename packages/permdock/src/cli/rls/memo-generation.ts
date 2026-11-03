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

/**
 * The triggers that invalidate the memo when a write changes permitted ids
 * without changing a membership: the permission map, a custom role's grants and
 * a suspended user or scope. The hook's version triggers call the same bump.
 */
export function memoGenerationSql(ctx: RlsSqlContext): string {
  if (!memoizes(ctx)) {
    return "";
  }
  const schema = helperSchema(ctx);
  const targets = new Map<string, Target>();
  add(targets, `${schema}.role_permissions`);
  if (ctx.customRoles !== undefined) {
    add(targets, `${schema}.${CUSTOM_ROLES.permissions}`);
    add(targets, `${schema}.${CUSTOM_ROLES.includes}`);
  }
  suspensionTargets(targets, ctx.suspension?.users);
  for (const row of Object.values(ctx.suspension?.scopes ?? {})) {
    suspensionTargets(targets, row);
  }
  const bump = qualified(ctx, BUMP);
  const trigger = qualified(ctx, TRIGGER);
  const triggers = [...targets.values()]
    .map(({ table, columns }) => {
      const target = quoteTable(qualifySqlTable(table));
      const update =
        columns === undefined
          ? "update"
          : `update of ${[...columns].map((column) => quoteIdent(column)).join(", ")}`;
      return `drop trigger if exists ${quoteIdent(TRIGGER)} on ${target};
create trigger ${quoteIdent(TRIGGER)}
  after insert or ${update} or delete on ${target}
  for each row execute function ${trigger}();`;
    })
    .join("\n");
  return `-- a permission, custom-role or suspension write changes permitted ids inside the statement
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
${triggers}`;
}
