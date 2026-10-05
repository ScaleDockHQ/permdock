import type { Policy } from "../index.ts";
import type { CompiledBranch } from "./rls-compile.ts";
import type { RlsSqlContext } from "./rls-sql.ts";

import { jsonSchemaOf } from "./catalog-doc.ts";
import { andSql, branchClauses, wrapSql } from "./rls-compile.ts";
import { signedIn } from "./rls-helpers.ts";
import { orSql } from "./rls-policies.ts";
import {
  qualifiedTable,
  quoteIdent,
  quoteLiteral,
  quoteTable,
} from "./rls-sql.ts";

/** Names of the field-view objects. Part of the SQL contract. */
export const FIELD_VIEWS = {
  /** `<table>_visible`: the `security_invoker` view clients read. */
  view: "_visible",
  /** `<table>_visible_fields`: the owner-rights companion `--revoke-columns` adds. */
  companion: "_visible_fields",
  /** The companion's row-key column, joined to the base table's key. */
  key: "permdock_key",
  /** Marks the companion so doctor PD022 knows it reads as its owner on purpose. */
  comment: "permdock:field-companion",
} as const;

export type FieldColumn = {
  readonly name: string;
  /** `case when <mask> then col end`; absent when no grant limits the column. */
  readonly mask?: string;
};

export type FieldView = {
  readonly resource: string;
  readonly table: string;
  readonly view: string;
  /** The row key; it always passes through so the view can be filtered and joined. */
  readonly key: string;
  readonly columns: readonly FieldColumn[];
  /** Postgres roles that read the view: `authenticated`, plus `anon` when an `anon` branch reads the table. */
  readonly roles: readonly string[];
  /** Set with `--revoke-columns`. */
  readonly companion?: string;
};

function covers(branch: CompiledBranch, column: string): boolean {
  return branch.fields === undefined || branch.fields.includes(column);
}

/**
 * A read grant that only shapes columns: a field-limited deny (it never
 * denies the row) or an allow with an empty list (it grants nothing). With
 * field views it leaves the row policy and lives in the view's masks.
 */
function fieldOnly(branch: CompiledBranch): boolean {
  if (branch.command !== "select" || branch.fields === undefined) {
    return false;
  }
  return branch.effect === "deny" || branch.fields.length === 0;
}

/** Branches the row policies keep when field views compile. */
export function rowBranches(
  branches: readonly CompiledBranch[],
): CompiledBranch[] {
  return branches.filter((branch) => !fieldOnly(branch));
}

/**
 * Whether the reader is signed in, for branches with no helper call: a grant
 * to any signed-in user relies on `to authenticated` in its policy, which a
 * view does not have.
 */
function audience(
  ctx: RlsSqlContext,
  branch: CompiledBranch,
): string | undefined {
  if (branch.access !== undefined || branch.roles.length !== 1) {
    return undefined;
  }
  if (branch.roles[0] === "authenticated") {
    return signedIn(ctx);
  }
  return branch.roles[0] === "anon" ? `not (${signedIn(ctx)})` : undefined;
}

function clause(ctx: RlsSqlContext, branch: CompiledBranch): string {
  return andSql(audience(ctx, branch), branchClauses(branch).using) ?? "true";
}

/**
 * `can(permission, row, { field })` in SQL: an allow that covers the column
 * holds for the row and no covering deny does. Every access term is the
 * uncorrelated helper call the row policy uses, so it runs once per statement.
 */
function maskSql(
  ctx: RlsSqlContext,
  allows: readonly CompiledBranch[],
  denies: readonly CompiledBranch[],
  column: string,
): string {
  const allowed = allows
    .filter((branch) => covers(branch, column))
    .map((branch) => clause(ctx, branch));
  if (allowed.length === 0) {
    return "false";
  }
  const denied = denies
    .filter((branch) => covers(branch, column))
    .map((branch) => clause(ctx, branch));
  const allow = orSql(allowed);
  if (denied.length === 0) {
    return allow;
  }
  const deny = orSql(denied);
  return allow === "true"
    ? `not ${wrapSql(deny)}`
    : `${wrapSql(allow)} and not ${wrapSql(deny)}`;
}

function schemaColumns(
  policy: Policy,
  resource: string,
): readonly string[] | undefined {
  const node = policy.resources.get(resource);
  const schema = node === undefined ? null : jsonSchemaOf(node);
  // SAFETY: schema was checked to be a non-null object; properties stays unknown.
  const properties =
    schema !== null && typeof schema === "object"
      ? (schema as { readonly properties?: unknown }).properties
      : undefined;
  return properties !== null && typeof properties === "object"
    ? Object.keys(properties)
    : undefined;
}

export function viewName(table: string, suffix: string): string {
  return `${table}${suffix}`;
}

/**
 * One view per table whose read grants limit fields. A column is restricted
 * when some read allow lists fields without it or some read deny lists it;
 * every other column, and the row key, passes through unchanged.
 */
export function fieldViews(
  policy: Policy,
  ctx: RlsSqlContext,
  branches: readonly CompiledBranch[],
  options: { readonly revokeColumns: boolean; readonly helpersOnly?: boolean },
  warnings: string[],
): readonly FieldView[] {
  const byTable = new Map<string, CompiledBranch[]>();
  for (const branch of branches) {
    if (branch.command !== "select" || branch.coverage === true) {
      continue;
    }
    byTable.set(branch.table, [...(byTable.get(branch.table) ?? []), branch]);
  }
  const views: FieldView[] = [];
  for (const [table, reads] of byTable) {
    const allows = reads.filter(
      (branch) => branch.effect === "allow" && branch.fields?.length !== 0,
    );
    const denies = reads.filter((branch) => branch.effect === "deny");
    const limited = reads.some((branch) => branch.fields !== undefined);
    const resource = reads.find(
      (branch) => branch.resource !== undefined,
    )?.resource;
    if (!limited || allows.length === 0 || resource === undefined) {
      continue;
    }
    const names = schemaColumns(policy, resource);
    if (names === undefined) {
      throw new Error(
        `PermDock CLI: --fields views needs the ${resource} schema's JSON Schema (Standard JSON Schema) to list the columns of ${table}`,
      );
    }
    const key = policy.resources.get(resource)?.id ?? "id";
    const restricted = (column: string): boolean =>
      column !== key &&
      (allows.some(
        (branch) =>
          branch.fields !== undefined && !branch.fields.includes(column),
      ) ||
        denies.some((branch) => branch.fields?.includes(column) === true));
    const columns = names.map((name): FieldColumn => {
      quoteIdent(name);
      return restricted(name)
        ? { name, mask: maskSql(ctx, allows, denies, name) }
        : { name };
    });
    if (columns.every((column) => column.mask === undefined)) {
      continue;
    }
    const view = viewName(table, FIELD_VIEWS.view);
    if (
      allows.some(
        (branch) => branch.fields !== undefined && !branch.fields.includes(key),
      )
    ) {
      warnings.push(
        `field view ${view}: the key ${key} passes through, although a read grant on ${resource} omits it`,
      );
    }
    const hidden = columns
      .filter((column) => column.mask !== undefined)
      .map((column) => column.name);
    if (options.helpersOnly === true) {
      warnings.push(
        `field view ${view}: ${table} still returns ${hidden.join(", ")} to direct reads; revoke select on those columns from client roles in your own grants, or read them through a function`,
      );
    } else if (!options.revokeColumns) {
      warnings.push(
        `field view ${view}: ${table} still returns ${hidden.join(", ")} to direct reads; add --revoke-columns so clients read through the view`,
      );
    }
    views.push({
      resource,
      table,
      view,
      key,
      columns,
      roles: reads.some((branch) => branch.roles.includes("anon"))
        ? ["anon", "authenticated"]
        : ["authenticated"],
      ...(options.revokeColumns
        ? { companion: viewName(table, FIELD_VIEWS.companion) }
        : {}),
    });
  }
  return views;
}

/** Columns of `view`'s table that `anon` and `authenticated` keep on the base table with `--revoke-columns`. */
function readableColumns(view: FieldView): readonly string[] {
  return view.columns
    .filter((column) => column.mask === undefined)
    .map((column) => column.name);
}

function restrictedColumns(view: FieldView): readonly string[] {
  return view.columns
    .filter((column) => column.mask !== undefined)
    .map((column) => column.name);
}

function columnList(names: readonly string[]): string {
  return names.map(quoteIdent).join(", ");
}

function selectList(lines: readonly string[]): string {
  return lines.map((line) => `  ${line}`).join(",\n");
}

function grantView(name: string, roles: readonly string[]): string {
  return [
    `revoke all on table ${quoteTable(qualifiedTable(name))} from anon, authenticated, public;`,
    `grant select on table ${quoteTable(qualifiedTable(name))} to ${roles.join(", ")};`,
  ].join("\n");
}

function inlineViewSql(view: FieldView): string {
  const targets = view.columns.map((column) =>
    column.mask === undefined
      ? quoteIdent(column.name)
      : `case when ${column.mask} then ${quoteIdent(column.name)} end as ${quoteIdent(column.name)}`,
  );
  return `create or replace view ${quoteTable(qualifiedTable(view.view))} with (security_invoker = true) as
select
${selectList(targets)}
from ${quoteTable(qualifiedTable(view.table))};`;
}

function companionSql(view: FieldView, companion: string): string {
  const restricted = view.columns.filter((column) => column.mask !== undefined);
  const targets = [
    `${quoteIdent(view.key)} as ${quoteIdent(FIELD_VIEWS.key)}`,
    ...restricted.map(
      (column) =>
        `case when ${column.mask} then ${quoteIdent(column.name)} end as ${quoteIdent(column.name)}`,
    ),
  ];
  const any = orSql(restricted.map((column) => column.mask ?? "false"));
  return `create or replace view ${quoteTable(qualifiedTable(companion))} with (security_barrier = true) as
select
${selectList(targets)}
from ${quoteTable(qualifiedTable(view.table))}
where ${any};
comment on view ${quoteTable(qualifiedTable(companion))} is ${quoteLiteral(`${FIELD_VIEWS.comment} ${view.view}`)};`;
}

function joinedViewSql(view: FieldView, companion: string): string {
  const targets = view.columns.map((column) =>
    column.mask === undefined
      ? `t.${quoteIdent(column.name)}`
      : `f.${quoteIdent(column.name)}`,
  );
  return `create or replace view ${quoteTable(qualifiedTable(view.view))} with (security_invoker = true) as
select
${selectList(targets)}
from ${quoteTable(qualifiedTable(view.table))} t
left join ${quoteTable(qualifiedTable(companion))} f on f.${quoteIdent(FIELD_VIEWS.key)} = t.${quoteIdent(view.key)};`;
}

/** `select` on only the unrestricted columns (and the key) of the base table, for `--revoke-columns`. */
export function columnGrantSql(view: FieldView, role: string): string {
  return `grant select (${columnList(readableColumns(view))}) on table ${quoteTable(qualifiedTable(view.table))} to ${role};`;
}

export function columnRevokeSql(view: FieldView): string {
  return `revoke select (${columnList(restrictedColumns(view))}) on table ${quoteTable(qualifiedTable(view.table))} from anon, authenticated;`;
}

/**
 * The view SQL: the `security_invoker` view, and with `--revoke-columns` the
 * owner-rights companion it joins for the restricted columns. The companion
 * masks every column with the full field decision and keeps only rows where
 * one is readable, so reading it directly shows nothing `pick` would not.
 */
export function fieldViewsSql(views: readonly FieldView[]): string {
  return views
    .map((view) => {
      const head = `-- field view over ${view.table}: ${restrictedColumns(view).join(", ")} read as null unless a read grant covers the column for the row`;
      if (view.companion === undefined) {
        return [
          head,
          inlineViewSql(view),
          grantView(view.view, view.roles),
        ].join("\n");
      }
      return [
        head,
        `-- ${view.companion} reads ${view.table} as its owner; ${view.view} reads the rows as the caller and joins it`,
        companionSql(view, view.companion),
        grantView(view.companion, view.roles),
        joinedViewSql(view, view.companion),
        grantView(view.view, view.roles),
      ].join("\n");
    })
    .join("\n\n");
}
