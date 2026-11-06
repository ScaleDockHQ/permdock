import type { Policy } from "../../index.ts";
import type { CompiledPolicy, SqlCommand } from "../sql/compile.ts";
import type { RlsSqlContext } from "../sql/context.ts";
import type { RlsTable, RlsTableOwner } from "../types.ts";

import { configError } from "../core/errors.ts";
import { idTypeOf } from "../sql/columns.ts";
import { graphSqlName } from "../sql/names.ts";
import {
  qualified,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "../sql/quote.ts";
import { tableNameOf } from "../sql/tables.ts";

function isOwner(entry: RlsTable): entry is RlsTableOwner {
  return typeof entry === "object" && !("tableOf" in entry);
}

function bare(table: string): string {
  return table.slice(table.lastIndexOf(".") + 1);
}

function policyName(table: string, command: SqlCommand): string {
  const slug = bare(table)
    .replaceAll(/[^A-Za-z0-9]+/gu, "_")
    .replaceAll(/^_|_$/gu, "");
  const full = `permdock_follow_${slug}_${command}`;
  if (new TextEncoder().encode(full).length > 63) {
    throw configError(
      `PermDock CLI: the follows policy name ${full} is longer than Postgres's 63 bytes; shorten '${table}'`,
    );
  }
  return full;
}

/**
 * Child policies for `rls.tables.<resource>.follows`. Select calls
 * `can_<resource>(parent, '<resource>.read')`. Insert, update and delete call
 * it with `<resource>.update`. The child resource gets no permission of its
 * own.
 */
export function followPolicies(
  ctx: RlsSqlContext,
  policy: Policy,
  tables: Readonly<Record<string, RlsTable>> | undefined,
): readonly CompiledPolicy[] {
  const out: CompiledPolicy[] = [];
  for (const [resource, entry] of Object.entries(tables ?? {})) {
    if (!isOwner(entry) || entry.follows === undefined) {
      continue;
    }
    const node = policy.resources.get(resource);
    if (node === undefined) {
      throw configError(
        `PermDock CLI: rls.tables.${resource}.follows names a resource the policy does not declare`,
      );
    }
    const sql = graphSqlName(resource);
    if (sql === undefined) {
      throw configError(
        `PermDock CLI: rls.tables.${resource} is not a SQL name, so follows cannot call can_${resource}`,
      );
    }
    const parent = quoteQualified(tableNameOf(entry, resource, tables));
    const id = quoteIdent(node.id);
    const can = qualified(ctx, `can_${sql}`);
    for (const [child, fk] of Object.entries(entry.follows)) {
      const childName = quoteIdent(bare(child));
      const column = quoteIdent(fk);
      const exists = (action: "read" | "update"): string =>
        `exists (select 1 from ${parent} p where p.${id} = ${childName}.${column} and ${can}(p, ${quoteLiteral(`${resource}.${action}`)}))`;
      const commands: readonly [
        SqlCommand,
        "read" | "update",
        "using" | "check" | "both",
      ][] = [
        ["select", "read", "using"],
        ["insert", "update", "check"],
        ["update", "update", "both"],
        ["delete", "update", "using"],
      ];
      for (const [command, action, place] of commands) {
        const expression = exists(action);
        out.push({
          name: policyName(child, command),
          table: child,
          command,
          effect: "allow",
          roles: ["authenticated"],
          ...(place === "check" ? {} : { using: expression }),
          ...(place === "using" ? {} : { check: expression }),
        });
      }
    }
  }
  return out;
}

/**
 * `walk: "recursive"`: one set of the rows below the caller on a self-parented
 * resource. With approval delegations, a caller also starts from the delegators
 * whose cover is active.
 */
export function walkChainSql(
  ctx: RlsSqlContext,
  policy: Policy,
  tables: Readonly<Record<string, RlsTable>> | undefined,
  covers: boolean,
): string {
  const chunks: string[] = [];
  for (const [resource, entry] of Object.entries(tables ?? {})) {
    if (!isOwner(entry) || entry.walk !== "recursive") {
      continue;
    }
    const node = policy.resources.get(resource);
    const parent = node?.parent;
    if (
      node === undefined ||
      parent === undefined ||
      parent.resource !== resource
    ) {
      throw configError(
        `PermDock CLI: rls.tables.${resource}.walk needs a self-parented resource`,
      );
    }
    const sql = graphSqlName(resource);
    if (sql === undefined) {
      throw configError(
        `PermDock CLI: rls.tables.${resource}.walk is not a SQL name`,
      );
    }
    const type = idTypeOf(ctx, resource);
    const table = quoteQualified(tableNameOf(entry, resource, tables));
    const id = quoteIdent(node.id);
    const up = quoteIdent(parent.field);
    const fn = qualified(ctx, `permdock_${sql}_chain`);
    const me = `(select ${qualified(ctx, "permdock_user_id")}())`;
    const cover = covers
      ? `
    union
    select d.delegator
    from ${qualified(ctx, "approval_delegations")} d
    where d.delegate = ${me}
      and d."from" <= now()
      and d."until" > now()`
      : "";
    chunks.push(`-- ${resource}: rows below the caller, one recursive set
create or replace function ${fn}()
returns setof ${type}
language sql
stable
security definer
set search_path = ''
as $$
  with recursive chain(id) as (
    select t.${id}
    from ${table} t
    where t.${up} = ${me}${cover}
    union
    select c.${id}
    from ${table} c
    join chain w on c.${up} = w.id
  )
  select id from chain
$$;
revoke execute on function ${fn}() from public, anon;
grant execute on function ${fn}() to authenticated;`);
  }
  return chunks.join("\n\n");
}
