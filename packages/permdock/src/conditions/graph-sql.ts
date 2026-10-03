import type { RelatedCondition } from "./ast.ts";

import { assertSafeKey } from "../core/paths.ts";
import {
  type EdgeRelation,
  type ResourceNode,
  expandRelation,
  isEdgeRelation,
  isFieldRelation,
  isPrincipalRelation,
  isSelfParented,
} from "../core/permissions.ts";
import { DEFAULT_GROUP_DEPTH } from "../core/relations.ts";

/**
 * Postgres SQL as parts, so each compiler binds values and names columns its
 * own way: literal `text`, a bound `value`, the subject's id as text, or a
 * `column` of the row being filtered.
 */
export type GraphSqlPart =
  | { readonly text: string }
  | { readonly value: string | number | boolean }
  /** Compared with an uncast column, so its index applies: render a bound parameter or the column's type. */
  | { readonly subject: true }
  | { readonly column: string };

export type GraphSql = readonly GraphSqlPart[];

/** Where the graph lives in the database, as the `toWhere` compilers take it. */
export type RelationsMapping = {
  /** The table of each resource the graph reads; default the resource name. */
  readonly tables?: Readonly<Record<string, string>>;
  /**
   * A closure table (`resource`, `ancestor`, `descendant`, `depth`) such as
   * the one `permdock rls` keeps. Without it, parent walks are a bounded
   * recursive query over the resource's own table.
   */
  readonly closure?: string;
};

export type GraphSqlOptions = RelationsMapping & {
  readonly resources: ReadonlyMap<string, ResourceNode>;
  /** Deepest walk the closure holds per resource; a resource absent here walks its table. Default: the closure holds every resource. */
  readonly closureDepths?: Readonly<Record<string, number>>;
  /** Ids of `resource` the subject holds `relation` on, in place of the inline query (RLS calls its helper). */
  readonly holders?: (resource: string, relation: string) => GraphSql;
  /** Ids of `resource` whose `link` points into `targets`, in place of reading its table (RLS calls a helper). */
  readonly linked?: (
    resource: string,
    link: string,
    targets: GraphSql,
  ) => GraphSql;
  /** Qualifies a table or edge name before it is quoted, e.g. with a schema for `search_path = ''`. */
  readonly qualify?: (table: string) => string;
};

/** A Postgres identifier, schema-qualified names split on `.`. */
export function quoteSqlName(name: string): string {
  return name
    .split(".")
    .map((part) => {
      assertSafeKey(part, "sql identifier");
      if (part === "" || part.includes("\0")) {
        throw new Error(`PermDock: unsafe SQL identifier '${name}'`);
      }
      return `"${part.replaceAll('"', '""')}"`;
    })
    .join(".");
}

type Build = {
  readonly options: GraphSqlOptions;
  alias: number;
};

function text(value: string): GraphSqlPart {
  return { text: value };
}

function nextAlias(build: Build, prefix: string): string {
  build.alias += 1;
  return `${prefix}${String(build.alias)}`;
}

function nodeOf(build: Build, resource: string): ResourceNode {
  const node = build.options.resources.get(resource);
  if (node === undefined) {
    throw new Error(`PermDock: graph resource '${resource}' is not declared`);
  }
  return node;
}

function tableName(build: Build, name: string): string {
  return quoteSqlName(build.options.qualify?.(name) ?? name);
}

function tableOf(build: Build, resource: string): string {
  return tableName(build, build.options.tables?.[resource] ?? resource);
}

function col(alias: string, name: string): string {
  return `${alias}.${quoteSqlName(name)}`;
}

function notExpired(column: string): string {
  return `(${column} is null or ${column} > now())`;
}

function edgeRowFilter(spec: EdgeRelation, alias: string): GraphSql {
  const parts: GraphSqlPart[] = [];
  for (const [column, value] of Object.entries(spec.match ?? {})) {
    parts.push(text(` and ${col(alias, column)} = `), { value });
  }
  if (spec.expiresAt !== undefined) {
    parts.push(text(` and ${notExpired(col(alias, spec.expiresAt))}`));
  }
  return parts;
}

function groupHolders(
  build: Build,
  resource: string,
  relation: string,
): GraphSql {
  return (
    build.options.holders?.(resource, relation) ??
    holderIds(build, resource, relation)
  );
}

/** Who a row of the edge names, when it is not a group of the edge's own resource. */
function edgeHolderFilter(
  build: Build,
  node: ResourceNode,
  spec: EdgeRelation,
  alias: string,
): GraphSql {
  const holder = col(alias, spec.subject ?? "user_id");
  const subject = `${holder}::text`;
  const groups = spec.groups;
  if (groups === undefined) {
    return [text(`${holder} = `), { subject: true }];
  }
  const kind = col(alias, groups.column);
  const direct: GraphSqlPart[] =
    groups.direct === undefined
      ? [text(`(${kind} is null`)]
      : [text(`(${kind} is null or ${kind} = `), { value: groups.direct }];
  const parts: GraphSqlPart[] = [
    text("(("),
    ...direct,
    text(`) and ${holder} = `),
    { subject: true },
    text(")"),
  ];
  for (const [resource, relation] of Object.entries(groups.resources)) {
    if (resource === node.name) {
      continue;
    }
    parts.push(
      text(` or (${kind} = `),
      { value: resource },
      text(` and ${subject} in (`),
      ...groupHolders(build, resource, relation),
      text("))"),
    );
  }
  parts.push(text(")"));
  return parts;
}

/**
 * One concrete relation's arm: `select <id>::text as id ...` for every
 * instance of `node` the subject holds `relation` on, through groups too.
 */
function relationArm(
  build: Build,
  node: ResourceNode,
  relation: string,
): GraphSql {
  const spec = node.relations[relation];
  if (isEdgeRelation(spec)) {
    const edge = tableName(build, spec.edge);
    const object = spec.object ?? `${node.name}_id`;
    const e = nextAlias(build, "e");
    const base: GraphSql = [
      text(`select ${col(e, object)}::text as id from ${edge} ${e} where `),
      ...edgeHolderFilter(build, node, spec, e),
      ...edgeRowFilter(spec, e),
    ];
    const self = spec.groups?.resources[node.name];
    if (self === undefined || spec.groups === undefined) {
      return base;
    }
    const g = nextAlias(build, "g");
    const n = nextAlias(build, "e");
    return [
      text(
        `select ${g}.id from (with recursive ${g}(id, level) as (select b.id, 0 from (`,
      ),
      ...base,
      text(
        `) b union select ${col(n, object)}::text, ${g}.level + 1 from ${edge} ${n} join ${g} on ${col(n, spec.subject ?? "user_id")}::text = ${g}.id where ${col(n, spec.groups.column)} = `,
      ),
      { value: node.name },
      text(` and ${g}.level < ${String(DEFAULT_GROUP_DEPTH)}`),
      ...edgeRowFilter(spec, n),
      text(`) select ${g}.id from ${g}) ${g}`),
    ];
  }
  const table = tableOf(build, node.name);
  const t = nextAlias(build, "t");
  const id = `${col(t, node.id)}::text`;
  if (isPrincipalRelation(spec)) {
    const parts: GraphSqlPart[] = [
      text(
        `select ${id} as id from ${table} ${t} where ${col(t, spec.principal)} = `,
      ),
      { subject: true },
    ];
    const startsAt = spec.period?.startsAt;
    if (startsAt !== undefined) {
      const column = col(t, startsAt);
      parts.push(text(` and (${column} is null or ${column} <= now())`));
    }
    const expiresAt = spec.period?.expiresAt;
    if (expiresAt !== undefined) {
      parts.push(text(` and ${notExpired(col(t, expiresAt))}`));
    }
    return parts;
  }
  if (isFieldRelation(spec) && spec.memberOf === undefined) {
    return [
      text(
        `select ${id} as id from ${table} ${t} where ${col(t, spec.field)} = `,
      ),
      { subject: true },
    ];
  }
  throw new Error(
    `PermDock: relation '${relation}' on ${node.name} has no graph SQL form`,
  );
}

function holderIds(build: Build, resource: string, relation: string): GraphSql {
  const node = nodeOf(build, resource);
  const arms = expandRelation(node, relation).map((name) =>
    relationArm(build, node, name),
  );
  if (arms.length === 0) {
    return [text("select null::text as id where false")];
  }
  const out: GraphSqlPart[] = [];
  for (const [index, arm] of arms.entries()) {
    if (index > 0) {
      out.push(text(" union "));
    }
    out.push(...arm);
  }
  return out;
}

/** One concrete relation's arm, for helpers that guard each arm by the relation asked for. */
export function relationArmSql(
  resource: string,
  relation: string,
  options: GraphSqlOptions,
): GraphSql {
  const build: Build = { options, alias: 0 };
  return relationArm(build, nodeOf(build, resource), relation);
}

/** A query of one text column `id`: the instances of `resource` the subject holds `relation` on, after `includes` and groups. */
export function holderIdsSql(
  resource: string,
  relation: string,
  options: GraphSqlOptions,
): GraphSql {
  return holderIds({ options, alias: 0 }, resource, relation);
}

function heldIds(build: Build, condition: RelatedCondition): GraphSql {
  if (condition.ids === undefined) {
    return groupHolders(build, condition.resource, condition.relation);
  }
  if (condition.ids.length === 0) {
    return [text("select null::text as id where false")];
  }
  const parts: GraphSqlPart[] = [text("select v.id from (values ")];
  for (const [index, id] of condition.ids.entries()) {
    parts.push(text(index === 0 ? "(" : ", ("), { value: id }, text("::text)"));
  }
  parts.push(text(") as v(id)"));
  return parts;
}

/** Instances of the condition's resource at or below the held ones, within its depth and never through a restricted child. */
function reached(build: Build, condition: RelatedCondition): GraphSql {
  const held = heldIds(build, condition);
  if (condition.depth === 0) {
    return held;
  }
  const node = nodeOf(build, condition.resource);
  if (!isSelfParented(node) || node.parent === undefined) {
    throw new Error(
      `PermDock: '${condition.resource}' is not self-parented, so a related walk of depth ${String(condition.depth)} has no SQL form`,
    );
  }
  const { closure, closureDepths } = build.options;
  if (
    closure !== undefined &&
    (closureDepths === undefined ||
      closureDepths[condition.resource] !== undefined)
  ) {
    const c = nextAlias(build, "c");
    const cap = closureDepths?.[condition.resource];
    const depth =
      cap !== undefined && condition.depth >= cap
        ? ""
        : ` and ${c}.depth <= ${String(condition.depth)}`;
    return [
      text(
        `select ${c}.descendant as id from ${quoteSqlName(closure)} ${c} where ${c}.resource = `,
      ),
      { value: condition.resource },
      text(`${depth} and ${c}.ancestor in (`),
      ...held,
      text(")"),
    ];
  }
  const d = nextAlias(build, "d");
  const t = nextAlias(build, "t");
  const restricted =
    node.restricted === undefined
      ? ""
      : ` and ${col(t, node.restricted)} is not true`;
  return [
    text(
      `select ${d}.id from (with recursive ${d}(id, level) as (select h.id, 0 from (`,
    ),
    ...held,
    text(
      `) h union select ${col(t, node.id)}::text, ${d}.level + 1 from ${tableOf(build, node.name)} ${t} join ${d} on ${col(t, node.parent.field)}::text = ${d}.id where ${d}.level < ${String(condition.depth)}${restricted}) select ${d}.id from ${d}) ${d}`,
    ),
  ];
}

/** Ids the row's `field` may hold: the reached instances, carried back over each link hop. */
function targets(build: Build, condition: RelatedCondition): GraphSql {
  let set = reached(build, condition);
  const hops = condition.hops ?? [];
  for (let index = hops.length - 1; index >= 1; index -= 1) {
    const from = hops[index - 1];
    const hop = hops[index];
    if (from === undefined || hop === undefined) {
      /* v8 ignore next */
      break;
    }
    const custom = build.options.linked?.(from.resource, hop.link, set);
    if (custom !== undefined) {
      set = custom;
      continue;
    }
    const node = nodeOf(build, from.resource);
    const link = Object.hasOwn(node.links, hop.link)
      ? node.links[hop.link]
      : undefined;
    if (link === undefined) {
      throw new Error(`PermDock: '${from.resource}' has no link '${hop.link}'`);
    }
    const t = nextAlias(build, "t");
    set = [
      text(
        `select ${col(t, node.id)}::text as id from ${tableOf(build, node.name)} ${t} where ${col(t, link.field)}::text in (`,
      ),
      ...set,
      text(")"),
    ];
  }
  return set;
}

/** The ids the row's field may hold for `condition` to match, as one text column `id`. */
export function relatedTargetsSql(
  condition: RelatedCondition,
  options: GraphSqlOptions,
): GraphSql {
  return targets({ options, alias: 0 }, condition);
}

/** Whether the row's restricted column keeps it out of `condition` whatever the graph says. */
export function relatedRowGuard(
  condition: RelatedCondition,
): string | undefined {
  const hopped = condition.hops !== undefined && condition.hops.length > 0;
  return (condition.parent === true || hopped) &&
    condition.restricted !== undefined
    ? condition.restricted
    : undefined;
}

/**
 * `condition` as a boolean over the filtered row that is never NULL: the
 * row's field is among the reached ids, and with `parent` or `hops` the row
 * is not restricted.
 */
export function relatedSql(
  condition: RelatedCondition,
  options: GraphSqlOptions,
): GraphSql {
  const parts: GraphSqlPart[] = [
    text("coalesce("),
    { column: condition.field },
    text("::text in ("),
    ...relatedTargetsSql(condition, options),
    text("), false)"),
  ];
  const guard = relatedRowGuard(condition);
  if (guard === undefined) {
    return parts;
  }
  return [
    text("("),
    ...parts,
    text(" and "),
    { column: guard },
    text(" is not true)"),
  ];
}

/**
 * Renders parts to one SQL string: `placeholder(n)` names the n-th bound
 * value (from 1), `column` names a row column, and the subject id binds as
 * a value.
 */
export function renderGraphSql(
  parts: GraphSql,
  render: {
    readonly subject: string;
    readonly placeholder: (index: number) => string;
    readonly column: (name: string) => string;
  },
): { readonly sql: string; readonly values: readonly unknown[] } {
  let sql = "";
  const values: unknown[] = [];
  for (const part of parts) {
    if ("text" in part) {
      sql += part.text;
    } else if ("column" in part) {
      sql += render.column(part.column);
    } else {
      values.push("subject" in part ? render.subject : part.value);
      sql += render.placeholder(values.length);
    }
  }
  return { sql, values };
}
