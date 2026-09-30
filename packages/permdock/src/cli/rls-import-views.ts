import { deparse, parse } from 'pgsql-parser';

import type { RolePermission } from './rls-helpers.ts';
import type { ImportedGrant } from './rls-import-ast.ts';
import type { RlsFunctionMapping, RlsMemberships } from './types.ts';

import { FIELD_VIEWS } from './rls-fields.ts';
import { helperGrants } from './rls-import-ast.ts';

type PgNode = Record<string, unknown>;

function asNode(value: unknown): PgNode | undefined {
  // SAFETY: checked to be a non-null, non-array object, which is all PgNode claims.
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as PgNode)
    : undefined;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function sval(value: unknown): string | undefined {
  const inner = asNode(asNode(value)?.['String']);
  return typeof inner?.['sval'] === 'string' ? inner['sval'] : undefined;
}

/** One restricted column of a generated field view, read back to the grants its mask names. */
export type ImportedFieldColumn = {
  readonly column: string;
  /** Helper-gated read allows that reveal the column. */
  readonly grants: readonly ImportedGrant[];
  /** Helper-gated read denies that hide it. */
  readonly denies: readonly ImportedGrant[];
};

/** A `<table>_visible` view in the shape `rls generate --fields views` writes. */
export type ImportedFieldView = {
  readonly view: string;
  readonly table: string;
  /** The owner-rights `<table>_visible_fields` companion, with `--revoke-columns`. */
  readonly companion?: string;
  readonly passthrough: readonly string[];
  readonly restricted: readonly ImportedFieldColumn[];
};

type RawView = {
  readonly name: string;
  readonly options: ReadonlySet<string>;
  readonly select: PgNode;
};

type Target = {
  readonly name: string;
  /** Alias qualifier of a plain column reference (`t`, `f`), if any. */
  readonly from?: string;
  readonly column?: string;
  readonly mask?: unknown;
};

function optionOn(value: unknown): string | undefined {
  const def = asNode(asNode(value)?.['DefElem']);
  if (typeof def?.['defname'] !== 'string') {
    return undefined;
  }
  const arg = sval(def['arg']) ?? 'true';
  return ['true', 'on', '1'].includes(arg.toLowerCase())
    ? def['defname'].toLowerCase()
    : undefined;
}

function viewsOf(stmts: readonly unknown[]): readonly RawView[] {
  const out: RawView[] = [];
  for (const item of stmts) {
    const view = asNode(asNode(asNode(item)?.['stmt'])?.['ViewStmt']);
    const relation = asNode(view?.['view']);
    const select = asNode(asNode(view?.['query'])?.['SelectStmt']);
    if (typeof relation?.['relname'] !== 'string' || select === undefined) {
      continue;
    }
    const options = new Set(
      list(view?.['options']).flatMap((option) => {
        const on = optionOn(option);
        return on === undefined ? [] : [on];
      }),
    );
    out.push({ name: relation['relname'], options, select });
  }
  return out;
}

function columnRef(
  value: unknown,
): { from?: string; column: string } | undefined {
  const fields = list(asNode(asNode(value)?.['ColumnRef'])?.['fields']).map(
    sval,
  );
  const column = fields.at(-1);
  if (column === undefined || fields.some((field) => field === undefined)) {
    return undefined;
  }
  const from = fields.at(-2);
  return fields.length > 1 && from !== undefined
    ? { from, column }
    : { column };
}

function targetOf(value: unknown): Target | undefined {
  const target = asNode(asNode(value)?.['ResTarget']);
  if (target === undefined) {
    return undefined;
  }
  const plain = columnRef(target['val']);
  const alias = typeof target['name'] === 'string' ? target['name'] : undefined;
  if (plain !== undefined) {
    return {
      name: alias ?? plain.column,
      column: plain.column,
      ...(plain.from === undefined ? {} : { from: plain.from }),
    };
  }
  const when = asNode(
    asNode(list(asNode(asNode(target['val'])?.['CaseExpr'])?.['args'])[0])?.[
      'CaseWhen'
    ],
  );
  const result = when === undefined ? undefined : columnRef(when['result']);
  if (when === undefined || result === undefined) {
    return undefined;
  }
  return {
    name: alias ?? result.column,
    column: result.column,
    mask: when['expr'],
  };
}

type Source = {
  readonly table: string;
  readonly alias?: string;
  readonly companion?: { readonly name: string; readonly alias?: string };
};

function rangeVar(
  value: unknown,
): { name: string; alias?: string } | undefined {
  const range = asNode(asNode(value)?.['RangeVar']);
  if (typeof range?.['relname'] !== 'string') {
    return undefined;
  }
  const alias = asNode(range['alias'])?.['aliasname'];
  return typeof alias === 'string'
    ? { name: range['relname'], alias }
    : { name: range['relname'] };
}

function sourceOf(select: PgNode): Source | undefined {
  const from = list(select['fromClause']);
  if (from.length !== 1) {
    return undefined;
  }
  const direct = rangeVar(from[0]);
  if (direct !== undefined) {
    return direct.alias === undefined
      ? { table: direct.name }
      : { table: direct.name, alias: direct.alias };
  }
  const join = asNode(asNode(from[0])?.['JoinExpr']);
  const left = rangeVar(join?.['larg']);
  const right = rangeVar(join?.['rarg']);
  if (
    join?.['jointype'] !== 'JOIN_LEFT' ||
    left === undefined ||
    right === undefined
  ) {
    return undefined;
  }
  return {
    table: left.name,
    ...(left.alias === undefined ? {} : { alias: left.alias }),
    companion: right,
  };
}

/** A mask is `allow`, `not deny` or `allow and not deny`; the generator puts the deny last. */
function splitMask(mask: unknown): { allow?: unknown; deny?: unknown } {
  const bool = asNode(asNode(mask)?.['BoolExpr']);
  if (bool?.['boolop'] === 'NOT_EXPR') {
    return { deny: list(bool['args'])[0] };
  }
  if (bool?.['boolop'] !== 'AND_EXPR') {
    return { allow: mask };
  }
  const args = list(bool['args']);
  const last = asNode(asNode(args.at(-1))?.['BoolExpr']);
  if (last?.['boolop'] !== 'NOT_EXPR') {
    return { allow: mask };
  }
  const rest = args.slice(0, -1);
  return {
    allow:
      rest.length === 1
        ? rest[0]
        : { BoolExpr: { boolop: 'AND_EXPR', args: rest } },
    deny: list(last['args'])[0],
  };
}

async function grantsOf(
  node: unknown,
  memberships: RlsMemberships | undefined,
  functions: Readonly<Record<string, RlsFunctionMapping>> | undefined,
  seeds: readonly RolePermission[],
): Promise<readonly ImportedGrant[]> {
  const expr = asNode(node);
  if (expr === undefined) {
    return [];
  }
  // SAFETY: expr is a node from pgsql-parser's own parse tree, which deparse accepts.
  return helperGrants(
    await deparse(expr as Parameters<typeof deparse>[0]),
    memberships,
    functions,
    seeds,
  );
}

/**
 * Reads back the field views `rls generate --fields views` writes: a
 * `security_invoker` `<table>_visible` whose restricted columns are
 * `case when <mask> then col end`, either inline or through the
 * `<table>_visible_fields` companion it joins. Other views are ignored.
 */
export async function fieldViewsFromSql(
  sql: string,
  memberships: RlsMemberships | undefined,
  functions: Readonly<Record<string, RlsFunctionMapping>> | undefined,
  seeds: readonly RolePermission[],
): Promise<readonly ImportedFieldView[]> {
  let stmts: readonly unknown[];
  try {
    stmts = list(asNode(await parse(sql))?.['stmts']);
  } catch {
    return [];
  }
  const views = viewsOf(stmts);
  const byName = new Map(views.map((view) => [view.name, view]));
  const out: ImportedFieldView[] = [];
  for (const view of views) {
    if (
      !view.name.endsWith(FIELD_VIEWS.view) ||
      !view.options.has('security_invoker')
    ) {
      continue;
    }
    const source = sourceOf(view.select);
    const targets = list(view.select['targetList']).map(targetOf);
    if (
      source === undefined ||
      targets.some((target) => target === undefined)
    ) {
      continue;
    }
    const companion =
      source.companion === undefined
        ? undefined
        : byName.get(source.companion.name);
    const masks = new Map<string, unknown>();
    if (source.companion !== undefined) {
      if (
        companion === undefined ||
        !companion.options.has('security_barrier')
      ) {
        continue;
      }
      for (const target of list(companion.select['targetList']).map(targetOf)) {
        if (target?.mask !== undefined) {
          masks.set(target.name, target.mask);
        }
      }
    }
    const passthrough: string[] = [];
    const restricted: ImportedFieldColumn[] = [];
    // SAFETY: the loop above skipped this view when any target was undefined.
    for (const target of targets as readonly Target[]) {
      const fromCompanion =
        source.companion !== undefined &&
        target.from !== undefined &&
        target.from === (source.companion.alias ?? source.companion.name);
      const mask =
        target.mask ?? (fromCompanion ? masks.get(target.name) : undefined);
      if (mask === undefined) {
        if (!fromCompanion) {
          passthrough.push(target.name);
        }
        continue;
      }
      const { allow, deny } = splitMask(mask);
      restricted.push({
        column: target.name,
        grants: await grantsOf(allow, memberships, functions, seeds),
        denies: await grantsOf(deny, memberships, functions, seeds),
      });
    }
    out.push({
      view: view.name,
      table: source.table,
      ...(source.companion === undefined
        ? {}
        : { companion: source.companion.name }),
      passthrough,
      restricted,
    });
  }
  return out;
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** `create view` statements for every view in the database, from `pg_get_viewdef` and the view's options. */
export async function viewsSqlFromDb(
  query: (
    sql: string,
  ) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>,
): Promise<string> {
  const result = await query(
    `select n.nspname as schema, c.relname as name, c.reloptions as options, pg_get_viewdef(c.oid) as definition
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'v' and n.nspname not in ('pg_catalog', 'information_schema')
     order by n.nspname, c.relname`,
  );
  return result.rows
    .flatMap((row) => {
      const { schema, name, definition } = row;
      if (
        typeof schema !== 'string' ||
        typeof name !== 'string' ||
        typeof definition !== 'string'
      ) {
        return [];
      }
      const options = Array.isArray(row['options'])
        ? row['options'].filter(
            (item): item is string => typeof item === 'string',
          )
        : [];
      const safe = options.filter((item) => /^[a-z_]+=[a-z0-9_]+$/u.test(item));
      const withOptions = safe.length === 0 ? '' : ` with (${safe.join(', ')})`;
      return [
        `create view ${quote(schema)}.${quote(name)}${withOptions} as ${definition.trim().replace(/;$/u, '')};`,
      ];
    })
    .join('\n');
}
