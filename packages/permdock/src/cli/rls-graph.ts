import type { Policy, ResourceNode } from '../index.ts';
import type { RlsSqlContext } from './rls-sql.ts';

import { flattenGrantee, relationCondition } from '../core/grantee.ts';
import {
  isEdgeRelation,
  isFieldRelation,
  isPrincipalRelation,
  isSelfParented,
} from '../core/permissions.ts';
import { scopeList } from '../core/scopes.ts';
import {
  CLOSURE,
  graphHelper,
  quoteIdent,
  quoteLiteral,
  quoteTable,
  subjectIdSql,
} from './rls-sql.ts';

export { CLOSURE };

function qualified(ctx: RlsSqlContext, name: string): string {
  return `${quoteIdent(ctx.schema ?? 'public')}.${name}`;
}

function tableFor(
  resource: string,
  tables: Readonly<Record<string, string>> | undefined,
): string {
  return tables?.[resource] ?? resource;
}

/** One resource the graph grants read: the relations they name and, when they walk it, the closure depth. */
export type GraphResource = {
  readonly node: ResourceNode;
  readonly relations: ReadonlySet<string>;
  /** Deepest `depth` any grant walks; absent when no grant walks the resource. */
  readonly closure?: number;
};

export type GraphPlan = ReadonlyMap<string, GraphResource>;

/** Every `related` condition the policy's grants compile to, with the resource graph they need. */
export function graphPlan(policy: Policy): GraphPlan {
  const scopes = scopeList(policy.scopes);
  const plan = new Map<
    string,
    { node: ResourceNode; relations: Set<string>; closure?: number }
  >();
  for (const grant of policy.grants) {
    const row = policy.resources.get(grant.permission.resource);
    for (const item of flattenGrantee(grant.to)) {
      if (item.kind !== 'relation') {
        continue;
      }
      const condition = relationCondition(item, row, scopes, {
        resources: policy.resources,
      });
      if (condition?.op !== 'related') {
        continue;
      }
      const node = policy.resources.get(condition.resource);
      if (node === undefined) {
        continue;
      }
      const entry = plan.get(node.name) ?? { node, relations: new Set() };
      entry.relations.add(condition.relation);
      if (condition.depth > 0 && isSelfParented(node)) {
        entry.closure = Math.max(entry.closure ?? 0, condition.depth);
      }
      plan.set(node.name, entry);
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
  return quoteTable(name.includes('.') ? name : `public.${name}`);
}

function textSubject(ctx: RlsSqlContext): string {
  return `${subjectIdSql(ctx)}::text`;
}

/** The `permitted_<resource>_ids(relation)` arm for one relation: ids of `resource` the subject holds it on. */
function relationArm(
  ctx: RlsSqlContext,
  node: ResourceNode,
  relation: string,
  tables: Readonly<Record<string, string>> | undefined,
): string {
  const spec = node.relations[relation];
  const guard = `(p_relation is null or p_relation = ${quoteLiteral(relation)})`;
  if (isEdgeRelation(spec)) {
    const object = quoteIdent(spec.object ?? `${node.name}_id`);
    const subject = quoteIdent(spec.subject ?? 'user_id');
    const parts = [guard, `e.${subject}::text = ${textSubject(ctx)}`];
    if (spec.expiresAt !== undefined) {
      const column = `e.${quoteIdent(spec.expiresAt)}`;
      parts.push(`(${column} is null or ${column} > now())`);
    }
    return `  select e.${object}::text from ${tableSql(spec.edge)} e\n  where ${parts.join('\n    and ')}`;
  }
  const table = tableSql(tableFor(node.name, tables));
  const id = `t.${quoteIdent(node.id)}::text`;
  if (isPrincipalRelation(spec)) {
    const parts = [
      guard,
      `t.${quoteIdent(spec.principal)}::text = ${textSubject(ctx)}`,
    ];
    const startsAt = spec.period?.startsAt;
    if (startsAt !== undefined) {
      const column = `t.${quoteIdent(startsAt)}`;
      parts.push(`(${column} is null or ${column} <= now())`);
    }
    const expiresAt = spec.period?.expiresAt;
    if (expiresAt !== undefined) {
      const column = `t.${quoteIdent(expiresAt)}`;
      parts.push(`(${column} is null or ${column} > now())`);
    }
    return `  select ${id} from ${table} t\n  where ${parts.join('\n    and ')}`;
  }
  if (!isFieldRelation(spec) || spec.memberOf !== undefined) {
    throw new Error(
      `PermDock CLI: relation '${relation}' on ${node.name} is not a graph relation RLS can compile`,
    );
  }
  return `  select ${id} from ${table} t\n  where ${guard}\n    and t.${quoteIdent(spec.field)}::text = ${textSubject(ctx)}`;
}

function permittedSql(
  ctx: RlsSqlContext,
  entry: GraphResource,
  tables: Readonly<Record<string, string>> | undefined,
): string {
  const fn = qualified(ctx, graphHelper(entry.node.name));
  const arms = [...entry.relations]
    .toSorted()
    .map((relation) => relationArm(ctx, entry.node, relation, tables));
  return `-- ${entry.node.name}: ids the subject holds a relation on (all relations when p_relation is null)
create or replace function ${fn}(p_relation text)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
${arms.join('\n  union\n')}
$$;
revoke execute on function ${fn}(text) from public, anon;
grant execute on function ${fn}(text) to authenticated;`;
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
    return '';
  }
  const name = node.name;
  const closure = qualified(ctx, CLOSURE.table);
  const table = tableSql(tableFor(name, tables));
  const id = quoteIdent(node.id);
  const up = quoteIdent(parent.field);
  const stop =
    node.restricted === undefined
      ? 'false'
      : `coalesce(t.${quoteIdent(node.restricted)}, false)`;
  const stopParent =
    node.restricted === undefined
      ? 'false'
      : `coalesce(p.${quoteIdent(node.restricted)}, false)`;
  const refresh = qualified(ctx, `${CLOSURE.table}_${name}`);
  const changed = qualified(ctx, `${CLOSURE.table}_${name}_changed`);
  const literal = quoteLiteral(name);
  const restrictedChanged =
    node.restricted === undefined
      ? ''
      : ` or n.${quoteIdent(node.restricted)} is distinct from o.${quoteIdent(node.restricted)}`;
  const trigger = (suffix: string): string =>
    quoteIdent(`${CLOSURE.table}_${name}_${suffix}`);
  return `-- ${name}: rows reach their ancestors up to depth ${String(depth)}, stopping at a restricted row
drop policy if exists ${quoteIdent(`${CLOSURE.table}_${name}`)} on ${closure};
create policy ${quoteIdent(`${CLOSURE.table}_${name}`)} on ${closure}
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
drop trigger if exists ${trigger('insert')} on ${table};
create trigger ${trigger('insert')} after insert on ${table}
  referencing new table as new_rows
  for each statement execute function ${changed}();
drop trigger if exists ${trigger('update')} on ${table};
create trigger ${trigger('update')} after update on ${table}
  referencing old table as old_rows new table as new_rows
  for each statement execute function ${changed}();
drop trigger if exists ${trigger('delete')} on ${table};
create trigger ${trigger('delete')} after delete on ${table}
  referencing old table as old_rows
  for each statement execute function ${changed}();
drop trigger if exists ${trigger('truncate')} on ${table};
create trigger ${trigger('truncate')} after truncate on ${table}
  for each statement execute function ${changed}();
select ${refresh}(array(select t.${id}::text from ${table} t));`;
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
    return '';
  }
  for (const name of plan.keys()) {
    if (ctx.scopes.some((scope) => scope.name === name)) {
      throw new Error(
        `PermDock CLI: resource '${name}' has graph relations and shares its name with the ${name} scope, so ${graphHelper(name)} would replace the scope helper; rename the resource (permdock doctor PD032)`,
      );
    }
  }
  const entries = [...plan.values()].toSorted((a, b) =>
    a.node.name.localeCompare(b.node.name),
  );
  const chunks = entries.map((entry) => permittedSql(ctx, entry, tables));
  const walked = entries.filter((entry) => entry.closure !== undefined);
  if (walked.length > 0) {
    chunks.push(closureTableSql(ctx));
    for (const entry of walked) {
      chunks.push(closureObjectsSql(ctx, entry, entry.closure ?? 0, tables));
    }
  }
  return `${chunks.join('\n\n')}\n`;
}
