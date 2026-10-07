import type { Policy, ResourceNode } from "../index.ts";
import type { RlsSqlContext } from "./rls-sql.ts";

import { relationArmSql } from "../conditions/graph-sql.ts";
import { flattenGrantee, relationCondition } from "../core/grantee.ts";
import {
  expandRelation,
  groupEntries,
  isEdgeRelation,
  isFieldRelation,
  isPrincipalRelation,
  isSelfParented,
} from "../core/permissions.ts";
import { scopeList } from "../core/scopes.ts";
import { PERMDOCK_SCHEMA } from "../supabase/sources.ts";
import {
  CLOSURE,
  activeUserSql,
  graphHelper,
  graphSqlName,
  graphSqlText,
  linkHelper,
  qualifiedTable,
  quoteIdent,
  quoteLiteral,
  quoteTable,
} from "./rls-sql.ts";

function qualified(ctx: RlsSqlContext, name: string): string {
  return `${quoteIdent(ctx.schema ?? PERMDOCK_SCHEMA)}.${name}`;
}

function tableFor(
  resource: string,
  tables: Readonly<Record<string, string>> | undefined,
): string {
  return tables?.[resource] ?? resource;
}

/** One resource the graph grants read: the relations they name, the links they cross and, when they walk it, the closure depth. */
export type GraphResource = {
  readonly node: ResourceNode;
  /** Relations asked for, as grants and groups name them (before `includes`). */
  readonly relations: ReadonlySet<string>;
  /** Links a hop follows out of this resource. */
  readonly links: ReadonlySet<string>;
  /** Deepest `depth` any grant walks; absent when no grant walks the resource. */
  readonly closure?: number;
};

export type GraphPlan = ReadonlyMap<string, GraphResource>;

type PlanEntry = {
  node: ResourceNode;
  relations: Set<string>;
  links: Set<string>;
  closure?: number;
};

/** Every `related` condition the policy's grants compile to, with the resource graph they need, groups included. */
export function graphPlan(policy: Policy): GraphPlan {
  const scopes = scopeList(policy.scopes);
  const plan = new Map<string, PlanEntry>();
  const entryFor = (node: ResourceNode): PlanEntry => {
    const entry = plan.get(node.name) ?? {
      node,
      relations: new Set<string>(),
      links: new Set<string>(),
    };
    plan.set(node.name, entry);
    return entry;
  };
  const addRelation = (node: ResourceNode, relation: string): void => {
    const entry = entryFor(node);
    if (entry.relations.has(relation)) {
      return;
    }
    entry.relations.add(relation);
    for (const name of expandRelation(node, relation)) {
      const spec = node.relations[name];
      if (!isEdgeRelation(spec) || spec.groups === undefined) {
        continue;
      }
      for (const { resource, relation: groupRelation } of groupEntries(spec)) {
        const target = policy.resources.get(resource);
        if (target !== undefined && target.name !== node.name) {
          addRelation(target, groupRelation);
        }
      }
    }
  };
  for (const grant of policy.grants) {
    const row = policy.resources.get(grant.permission.resource);
    for (const item of flattenGrantee(grant.to)) {
      if (item.kind !== "relation") {
        continue;
      }
      const condition = relationCondition(item, row, scopes, {
        resources: policy.resources,
      });
      if (condition?.op !== "related") {
        continue;
      }
      const node = policy.resources.get(condition.resource);
      if (node === undefined) {
        continue;
      }
      addRelation(node, condition.relation);
      const entry = entryFor(node);
      if (condition.depth > 0 && isSelfParented(node)) {
        entry.closure = Math.max(entry.closure ?? 0, condition.depth);
      }
      const hops = condition.hops ?? [];
      for (let index = 1; index < hops.length; index += 1) {
        const from = policy.resources.get(hops[index - 1]?.resource ?? "");
        const hop = hops[index];
        if (from !== undefined && hop !== undefined) {
          entryFor(from).links.add(hop.link);
        }
      }
    }
  }
  return plan;
}

/** The closure depth per walked resource, as `RlsSqlContext.graph` carries it. */
export function closureDepths(
  plan: GraphPlan,
): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, entry] of plan) {
    if (entry.closure !== undefined) {
      out[name] = entry.closure;
    }
  }
  return out;
}

function tableSql(name: string): string {
  return quoteTable(qualifiedTable(name));
}

/**
 * The `permitted_<resource>_ids(relation)` arm for one concrete relation:
 * ids of `resource` the subject holds it on, directly or through a group.
 * `asked` are the relation names that include it, so a call for any of them
 * (or for all, with null) reads this arm.
 */
function relationArm(
  ctx: RlsSqlContext,
  plan: GraphPlan,
  node: ResourceNode,
  relation: string,
  asked: readonly string[],
  tables: Readonly<Record<string, string>> | undefined,
): string {
  const spec = node.relations[relation];
  if (
    !isEdgeRelation(spec) &&
    !isPrincipalRelation(spec) &&
    (!isFieldRelation(spec) || spec.memberOf !== undefined)
  ) {
    throw new Error(
      `PermDock CLI: relation '${relation}' on ${node.name} is not a graph relation RLS can compile`,
    );
  }
  const guard =
    asked.length === 1
      ? `(p_relation is null or p_relation = ${quoteLiteral(asked[0] ?? relation)})`
      : `(p_relation is null or p_relation in (${asked.map(quoteLiteral).join(", ")}))`;
  const body = graphSqlText(
    relationArmSql(node.name, relation, {
      resources: new Map([...plan].map(([name, item]) => [name, item.node])),
      ...(tables === undefined ? {} : { tables }),
      qualify: qualifiedTable,
      holders: (resource, groupRelation) => [
        {
          text: `select ${qualified(ctx, graphHelper(resource))}(${quoteLiteral(groupRelation)})`,
        },
      ],
    }),
    ctx,
  );
  const active = activeUserSql(ctx)
    .map((part) => ` and ${part}`)
    .join("");
  return `  select a.id from (${body}) a\n  where ${guard}${active}`;
}

function permittedSql(
  ctx: RlsSqlContext,
  plan: GraphPlan,
  entry: GraphResource,
  tables: Readonly<Record<string, string>> | undefined,
): string {
  const fn = qualified(ctx, graphHelper(entry.node.name));
  const asked = [...entry.relations].toSorted();
  const concrete = [
    ...new Set(asked.flatMap((name) => expandRelation(entry.node, name))),
  ].toSorted();
  const arms = concrete.map((relation) =>
    relationArm(
      ctx,
      plan,
      entry.node,
      relation,
      asked.filter((name) =>
        expandRelation(entry.node, name).includes(relation),
      ),
      tables,
    ),
  );
  if (arms.length === 0) {
    arms.push("  select null::text where false");
  }
  return `-- ${entry.node.name}: ids the subject holds a relation on (all relations when p_relation is null)
create or replace function ${fn}(p_relation text)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
${arms.join("\n  union\n")}
$$;
revoke execute on function ${fn}(text) from public, anon;
grant execute on function ${fn}(text) to authenticated;`;
}

/** `permdock_link_<resource>_<link>(ids)`: ids of `resource` whose link points into `ids`, read past the table's own policies. */
function linkSql(
  ctx: RlsSqlContext,
  node: ResourceNode,
  link: string,
  tables: Readonly<Record<string, string>> | undefined,
): string {
  const spec = Object.hasOwn(node.links, link) ? node.links[link] : undefined;
  if (spec === undefined) {
    throw new Error(`PermDock CLI: ${node.name} has no link '${link}'`);
  }
  const fn = qualified(ctx, linkHelper(node.name, link));
  return `-- ${node.name}.${link}: rows whose ${spec.field} points at one of the given ${spec.resource} ids
create or replace function ${fn}(p_ids text[])
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select t.${quoteIdent(node.id)}::text from ${tableSql(tableFor(node.name, tables))} t
  where t.${quoteIdent(spec.field)}::text = any(p_ids)
$$;
revoke execute on function ${fn}(text[]) from public, anon;
grant execute on function ${fn}(text[]) to authenticated;`;
}

function closureTableSql(ctx: RlsSqlContext): string {
  const table = qualified(ctx, CLOSURE.table);
  return `-- the object graph: one row per (ancestor, descendant) within each walked resource's depth,
-- never crossing a restricted row; kept current by statement triggers on each self-parented table
create table if not exists ${table} (
  resource text not null,
  ancestor text not null,
  descendant text not null,
  depth integer not null check (depth >= 0),
  primary key (resource, descendant, ancestor)
);
create index if not exists ${quoteIdent(`${CLOSURE.table}_ancestor`)} on ${table} (resource, ancestor);
alter table ${table} enable row level security;
revoke all on table ${table} from anon, authenticated, public;
grant select on table ${table} to authenticated;`;
}

function closureObjectsSql(
  ctx: RlsSqlContext,
  entry: GraphResource,
  depth: number,
  tables: Readonly<Record<string, string>> | undefined,
): string {
  const { node } = entry;
  const parent = node.parent;
  if (parent === undefined) {
    return "";
  }
  const name = node.name;
  const sqlName = graphSqlName(name) ?? name;
  const closure = qualified(ctx, CLOSURE.table);
  const table = tableSql(tableFor(name, tables));
  const id = quoteIdent(node.id);
  const up = quoteIdent(parent.field);
  const stop =
    node.restricted === undefined
      ? "false"
      : `coalesce(t.${quoteIdent(node.restricted)}, false)`;
  const stopParent =
    node.restricted === undefined
      ? "false"
      : `coalesce(p.${quoteIdent(node.restricted)}, false)`;
  const refresh = qualified(ctx, `${CLOSURE.table}_${sqlName}`);
  const changed = qualified(ctx, `${CLOSURE.table}_${sqlName}_changed`);
  const literal = quoteLiteral(name);
  const restrictedChanged =
    node.restricted === undefined
      ? ""
      : ` or n.${quoteIdent(node.restricted)} is distinct from o.${quoteIdent(node.restricted)}`;
  const trigger = (suffix: string): string =>
    quoteIdent(`${CLOSURE.table}_${sqlName}_${suffix}`);
  return `-- ${name}: rows reach their ancestors up to depth ${String(depth)}, stopping at a restricted row
drop policy if exists ${quoteIdent(`${CLOSURE.table}_${sqlName}`)} on ${closure};
create policy ${quoteIdent(`${CLOSURE.table}_${sqlName}`)} on ${closure}
  for select to authenticated
  using (resource = ${literal} and ancestor in (select ${qualified(ctx, graphHelper(name))}(null)));
create or replace function ${refresh}(p_ids text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cycle text;
  v_affected text[];
begin
  with recursive walk(start, next, path) as (
    select t.${id}, t.${up}, array[t.${id}::text]
    from ${table} t
    where t.${id}::text = any(p_ids)
    union all
    select walk.start, t.${up}, walk.path || t.${id}::text
    from walk join ${table} t on t.${id} = walk.next
    where not (walk.next::text = any(walk.path))
  )
  select walk.start::text into v_cycle
  from walk
  where walk.next::text = any(walk.path)
  limit 1;
  if v_cycle is not null then
    raise exception 'permdock: % % is its own ancestor', ${literal}, v_cycle
      using errcode = 'check_violation';
  end if;
  with recursive down(id, level) as (
    select t.${id}, 0
    from ${table} t
    where t.${id}::text = any(p_ids) or t.${up}::text = any(p_ids)
    union
    select t.${id}, down.level + 1
    from down join ${table} t on t.${up} = down.id
    where down.level < ${String(depth)}
  )
  select coalesce(array_agg(distinct down.id::text), '{}') into v_affected from down;
  delete from ${closure} c
  where c.resource = ${literal}
    and (c.descendant = any(p_ids) or c.descendant = any(v_affected));
  insert into ${closure} (resource, ancestor, descendant, depth)
  with recursive walk(descendant, ancestor, parent, depth, stop) as (
    select t.${id}::text, t.${id}, t.${up}, 0, ${stop}
    from ${table} t
    where t.${id}::text = any(v_affected)
    union all
    select walk.descendant, p.${id}, p.${up}, walk.depth + 1, ${stopParent}
    from walk join ${table} p on p.${id} = walk.parent
    where not walk.stop and walk.depth < ${String(depth)}
  )
  select ${literal}, walk.ancestor::text, walk.descendant, walk.depth from walk
  on conflict do nothing;
end
$$;
revoke execute on function ${refresh}(text[]) from public, anon, authenticated;
create or replace function ${changed}()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'TRUNCATE' then
    delete from ${closure} where resource = ${literal};
  elsif tg_op = 'INSERT' then
    perform ${refresh}(array(select n.${id}::text from new_rows n));
  elsif tg_op = 'DELETE' then
    perform ${refresh}(array(select o.${id}::text from old_rows o));
  else
    perform ${refresh}(array(
      select n.${id}::text
      from new_rows n left join old_rows o on o.${id} = n.${id}
      where o.${id} is null or n.${up} is distinct from o.${up}${restrictedChanged}
      union
      select o.${id}::text
      from old_rows o left join new_rows n on n.${id} = o.${id}
      where n.${id} is null
    ));
  end if;
  return null;
end
$$;
revoke execute on function ${changed}() from public, anon, authenticated;
drop trigger if exists ${trigger("insert")} on ${table};
create trigger ${trigger("insert")} after insert on ${table}
  referencing new table as new_rows
  for each statement execute function ${changed}();
drop trigger if exists ${trigger("update")} on ${table};
create trigger ${trigger("update")} after update on ${table}
  referencing old table as old_rows new table as new_rows
  for each statement execute function ${changed}();
drop trigger if exists ${trigger("delete")} on ${table};
create trigger ${trigger("delete")} after delete on ${table}
  referencing old table as old_rows
  for each statement execute function ${changed}();
drop trigger if exists ${trigger("truncate")} on ${table};
create trigger ${trigger("truncate")} after truncate on ${table}
  for each statement execute function ${changed}();
select ${refresh}(array(select t.${id}::text from ${table} t));`;
}

/** Group resources a resource's asked relations name, other than itself. */
function groupTargets(entry: GraphResource): readonly string[] {
  const out = new Set<string>();
  for (const asked of entry.relations) {
    for (const name of expandRelation(entry.node, asked)) {
      const spec = entry.node.relations[name];
      const resources = isEdgeRelation(spec)
        ? groupEntries(spec).map((group) => group.resource)
        : [];
      for (const resource of resources) {
        if (resource !== entry.node.name) {
          out.add(resource);
        }
      }
    }
  }
  return [...out].toSorted();
}

/** Plan entries by name, each after the group resources its helper calls (SQL function bodies are checked on create). */
function dependencyOrder(plan: GraphPlan): readonly GraphResource[] {
  const out: GraphResource[] = [];
  const done = new Set<string>();
  const visit = (name: string): void => {
    const entry = plan.get(name);
    if (entry === undefined || done.has(name)) {
      return;
    }
    done.add(name);
    for (const target of groupTargets(entry)) {
      visit(target);
    }
    out.push(entry);
  };
  for (const name of [...plan.keys()].toSorted()) {
    visit(name);
  }
  return out;
}

/**
 * The graph preamble: `permitted_<resource>_ids` for every resource a graph
 * grant reads, and the closure table with its triggers for every
 * self-parented resource a grant walks. Empty when no grant is a graph grant.
 */
export function graphSql(
  ctx: RlsSqlContext,
  plan: GraphPlan,
  tables: Readonly<Record<string, string>> | undefined,
): string {
  if (plan.size === 0) {
    return "";
  }
  const sqlNames = new Map<string, string>();
  for (const name of plan.keys()) {
    const helper = graphHelper(name);
    const sql = graphSqlName(name) ?? name;
    if (ctx.scopes.some((scope) => scope.name === sql)) {
      throw new Error(
        `PermDock CLI: resource '${name}' has graph relations and shares its SQL name with the ${sql} scope, so ${helper} would replace the scope helper; rename the resource (permdock doctor PD032)`,
      );
    }
    const other = sqlNames.get(sql);
    if (other !== undefined) {
      throw new Error(
        `PermDock CLI: resources '${other}' and '${name}' both name the SQL helper ${helper}; rename one (permdock doctor PD032)`,
      );
    }
    sqlNames.set(sql, name);
  }
  const entries = dependencyOrder(plan);
  const chunks = entries.flatMap((entry) => [
    ...(entry.relations.size === 0
      ? []
      : [permittedSql(ctx, plan, entry, tables)]),
    ...[...entry.links]
      .toSorted()
      .map((link) => linkSql(ctx, entry.node, link, tables)),
  ]);
  const walked = entries.filter((entry) => entry.closure !== undefined);
  if (walked.length > 0) {
    chunks.push(closureTableSql(ctx));
    for (const entry of walked) {
      chunks.push(closureObjectsSql(ctx, entry, entry.closure ?? 0, tables));
    }
  }
  return `${chunks.join("\n\n")}\n`;
}
