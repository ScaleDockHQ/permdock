import type { SQL } from "drizzle-orm";

import type { Condition } from "../conditions/ast.ts";
import type { WhereResult } from "../core/permdock.ts";
import type { Subject } from "../core/subject.ts";
import type {
  DrizzleOperators,
  DrizzleWhereOptions,
  DrizzleWithSubjectOptions,
} from "./types.ts";

import {
  type CompiledExists,
  type CompiledWhere,
  compileWhere,
  escapeLike,
} from "../conditions/compile.ts";
import { type RowCheck, rowCheckFrom } from "../conditions/row-check.ts";
import {
  statementTemplate,
  subjectStatements,
} from "../conditions/subject-settings.ts";
import { compact } from "../core/compact.ts";
import { assertSafeKey } from "../core/paths.ts";

function loadOperators(injected?: DrizzleOperators): DrizzleOperators {
  if (injected !== undefined) {
    return injected;
  }
  // Feature-detected so the entry loads on runtimes without a Node module
  // loader; there, pass `operators` (`import * as operators from 'drizzle-orm'`).
  // SAFETY: optional chaining guards a missing process; node:module is Node's createRequire module.
  const loader = (
    globalThis as {
      readonly process?: {
        readonly getBuiltinModule?: (id: string) => unknown;
      };
    }
  ).process?.getBuiltinModule?.("node:module") as
    | {
        readonly createRequire: (
          from: string,
        ) => (id: string) => DrizzleOperators;
      }
    | undefined;
  try {
    if (loader === undefined) {
      throw new Error("no module loader");
    }
    return loader.createRequire(import.meta.url)("drizzle-orm");
  } catch {
    throw new Error(
      "PermDock: permdock/drizzle requires the drizzle-orm peer; pass `operators` on runtimes without require",
    );
  }
}

function ident(name: string): string {
  assertSafeKey(name, "sql identifier");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(`PermDock: unsafe SQL identifier '${name}'`);
  }
  return name;
}

function column(
  table: object,
  field: string,
  columns: Readonly<Record<string, unknown>> | undefined,
): unknown {
  assertSafeKey(field, "condition field");
  // SAFETY: an own-key read on an object; the value is checked for undefined or function below.
  const mapped =
    (columns !== undefined && Object.hasOwn(columns, field)
      ? columns[field]
      : undefined) ??
    (Object.hasOwn(table, field)
      ? (table as Readonly<Record<string, unknown>>)[field]
      : undefined);
  if (mapped === undefined || typeof mapped === "function") {
    throw new Error(`PermDock: unknown column '${field}'`);
  }
  return mapped;
}

/** Drizzle's Postgres array columns (`text().array()`) report `dataType: 'array'`. */
function isArrayColumn(col: unknown): boolean {
  if (col === null || typeof col !== "object") {
    return false;
  }
  // SAFETY: checked to be a non-null object first; both fields are only compared.
  const { dataType, dimensions } = col as {
    readonly dataType?: unknown;
    readonly dimensions?: unknown;
  };
  // drizzle-orm 0.x sets `dataType: 'array'`; 1.x keeps the element type and counts `dimensions`.
  return (
    dataType === "array" || (typeof dimensions === "number" && dimensions > 0)
  );
}

/** Literal SQL text interleaved with bound values, rendered through `sql`. */
type SqlPart = { readonly text: string } | { readonly value: unknown };

function tagged(parts: readonly SqlPart[], ops: DrizzleOperators): unknown {
  const strings: string[] = [""];
  const values: unknown[] = [];
  for (const part of parts) {
    if ("text" in part) {
      strings[strings.length - 1] += part.text;
    } else {
      values.push(part.value);
      strings.push("");
    }
  }
  // SAFETY: a string array becomes a TemplateStringsArray once raw is defined on the next line.
  const template = strings as unknown as TemplateStringsArray;
  Object.defineProperty(template, "raw", { value: strings });
  return ops.sql(template, ...values);
}

function existsSql(
  node: CompiledExists,
  table: object,
  options: DrizzleWhereOptions,
  ops: DrizzleOperators,
): unknown {
  const m = (name: string): string => `m.${ident(name)}`;
  const parts: SqlPart[] = [
    {
      text: `exists (select 1 from ${ident(node.table)} m where ${m(node.rowColumn)} = `,
    },
    { value: column(table, node.rowField, options.columns) },
    { text: ` and ${m(node.user)} = ` },
    { value: node.userValue },
  ];
  if (node.roles.length > 0) {
    parts.push({ text: ` and ${m(node.role)} in (` });
    for (const [index, role] of node.roles.entries()) {
      if (index > 0) {
        parts.push({ text: ", " });
      }
      parts.push({ value: role });
    }
    parts.push({ text: ")" });
  }
  if (node.expiresAt !== undefined) {
    const expires = m(node.expiresAt);
    parts.push(
      { text: ` and (${expires} is null or ${expires} > ` },
      { value: node.now },
      { text: ")" },
    );
  }
  if (node.tenantColumn !== undefined && node.tenantValue !== undefined) {
    const tenant = m(node.tenantColumn);
    parts.push(
      { text: ` and (${tenant} is null or ${tenant} = ` },
      { value: node.tenantValue },
      { text: ")" },
    );
  }
  if (node.resourceColumn !== undefined && node.resourceValue !== undefined) {
    parts.push(
      { text: ` and ${m(node.resourceColumn)} = ` },
      { value: node.resourceValue },
    );
  }
  parts.push({ text: ")" });
  return tagged(parts, ops);
}

function containsSql(
  col: unknown,
  value: unknown,
  ops: DrizzleOperators,
): unknown {
  if (isArrayColumn(col)) {
    return tagged(
      [{ value }, { text: " = any(" }, { value: col }, { text: ")" }],
      ops,
    );
  }
  if (typeof value === "string") {
    return ops.like(col, `%${escapeLike(value)}%`);
  }
  return tagged([{ value: col }, { text: " @> " }, { value }], ops);
}

function render(
  node: CompiledWhere,
  table: object,
  options: DrizzleWhereOptions,
  ops: DrizzleOperators,
): unknown {
  switch (node.kind) {
    case "never":
      return ops.sql`false`;
    case "always":
      return ops.sql`true`;
    case "isNull": {
      const col = column(table, node.field, options.columns);
      return node.negated ? ops.isNotNull(col) : ops.isNull(col);
    }
    case "and":
      return ops.and(
        ...node.items.map((item) => render(item, table, options, ops)),
      );
    case "or":
      return ops.or(
        ...node.items.map((item) => render(item, table, options, ops)),
      );
    case "not":
      return ops.not(render(node.item, table, options, ops));
    case "exists":
      return existsSql(node, table, options, ops);
    case "sql":
      return tagged(
        node.parts.map((part): SqlPart => {
          if ("text" in part) {
            return part;
          }
          if ("column" in part) {
            return { value: column(table, part.column, options.columns) };
          }
          return { value: "subject" in part ? node.subject : part.value };
        }),
        ops,
      );
    case "compare": {
      const col = column(table, node.field, options.columns);
      switch (node.op) {
        case "eq":
          return ops.eq(col, node.value);
        case "ne":
          return ops.ne(col, node.value);
        case "gt":
          return ops.gt(col, node.value);
        case "gte":
          return ops.gte(col, node.value);
        case "lt":
          return ops.lt(col, node.value);
        case "lte":
          return ops.lte(col, node.value);
        case "in":
          // SAFETY: compileWhere emits in and notIn compares only with a non-empty array value.
          return ops.inArray(col, node.value as readonly unknown[]);
        case "notIn":
          // SAFETY: compileWhere emits in and notIn compares only with a non-empty array value.
          return ops.notInArray(col, node.value as readonly unknown[]);
        case "contains":
          return containsSql(col, node.value, ops);
        /* v8 ignore next 4 */
        default: {
          const exhaustive: never = node.op;
          throw new Error(`PermDock: unknown compare '${String(exhaustive)}'`);
        }
      }
    }
    /* v8 ignore next 6 */
    default: {
      const exhaustive: never = node;
      throw new Error(
        `PermDock: unknown compiled node '${String(exhaustive)}'`,
      );
    }
  }
}

/** Compiles a condition into a Drizzle `SQL` filter over `table`; no grant compiles to `false`. */
export function toWhere<T extends object>(
  input: Condition | WhereResult,
  table: T,
  options: DrizzleWhereOptions<T> = {},
): SQL {
  const compiled = compileWhere(
    input,
    compact({
      subject: options.subject,
      memberships: options.memberships,
      now: options.now,
      relations: options.relations,
    }),
  );
  // SAFETY: T only narrows the column values render reads as unknown; the operators build Drizzle SQL.
  return render(
    compiled,
    table,
    options as DrizzleWhereOptions,
    loadOperators(options.operators),
  ) as SQL;
}

type DrizzleDatabase<Tx> = {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
};

/**
 * Runs `fn` in a transaction whose role and claims are `permdock.subject`'s, so the generated
 * RLS policies decide for the same subject as the in-process checks.
 */
export function withSubject<Tx extends { execute(query: never): unknown }, T>(
  db: DrizzleDatabase<Tx>,
  permdock: { readonly subject: Subject },
  fn: (tx: Tx) => Promise<T>,
  options: DrizzleWithSubjectOptions = {},
): Promise<T> {
  const statements = subjectStatements(permdock, options);
  const { sql } = loadOperators(options.operators);
  return db.transaction(async (tx) => {
    // SAFETY: every query passed is built by drizzle-orm's own sql tag, which tx.execute accepts.
    const execute = tx.execute.bind(tx) as (query: unknown) => Promise<unknown>;
    for (const statement of statements) {
      // oxlint-disable-next-line no-await-in-loop -- the role must be set before the claims
      await execute(sql(statementTemplate(statement), ...statement.values));
    }
    return fn(tx);
  });
}

type DrizzleSelectable = {
  select(fields: Record<string, unknown>): {
    from(table: never): {
      where(where: unknown): {
        limit(
          count: number,
        ): PromiseLike<readonly { readonly granted?: unknown }[]>;
      };
    };
  };
};

/**
 * One query for one row: `{ found: false }` when `key` matches nothing, otherwise whether the
 * permission filter keeps the row. Throws when `key` matches more than one row.
 */
export async function checkRow<T extends object>(
  db: DrizzleSelectable,
  table: T,
  input: Condition | WhereResult,
  key: SQL,
  options: DrizzleWhereOptions<T> = {},
): Promise<RowCheck> {
  const { sql } = loadOperators(options.operators);
  const filter = toWhere(input, table, options);
  // SAFETY: from() is typed never so any Drizzle table fits; table is the caller's Drizzle table.
  const rows = await db
    .select({ granted: sql`coalesce((${filter}), false)` })
    .from(table as never)
    .where(key)
    .limit(2);
  return rowCheckFrom(rows);
}
