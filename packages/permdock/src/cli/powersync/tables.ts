import type { PowerSyncTable } from "../types.ts";
import type { StreamDialect, SubjectStream } from "./streams.ts";

import { SQL_IDENT } from "../../core/sql.ts";
import { bare, fromTable } from "./names.ts";

/**
 * The `SELECT`s of the ids of the `resource` rows the user reads (`undefined`
 * when none compiles), and why some of its rows do not sync.
 */
export type Permitted = (resource: string) => {
  readonly ids: readonly string[] | undefined;
  readonly gaps: readonly string[];
};

export type TableStreams = {
  readonly streams: readonly SubjectStream[];
  readonly warnings: readonly string[];
  readonly omitted: readonly {
    readonly resource: string;
    readonly reason: string;
  }[];
};

/**
 * One stream per `powersync.tables` entry: the user's own rows, and the rows
 * that point at a resource row the user reads. A stream of the user's own rows
 * alone carries `user`, so `verify` checks it holds no other user's row.
 */
export function tableStreams(
  tables: Readonly<Record<string, PowerSyncTable>>,
  dialect: StreamDialect,
  taken: ReadonlySet<string>,
  permitted: Permitted,
): TableStreams {
  const streams: SubjectStream[] = [];
  const warnings: string[] = [];
  const omitted: { resource: string; reason: string }[] = [];
  for (const [source, spec] of Object.entries(tables)) {
    const table = bare(source, dialect);
    const from = fromTable(source, dialect);
    const queries: string[] = [];
    const follows = spec.follow ?? [];
    const columns = [
      ...(spec.user === undefined ? [] : [spec.user]),
      ...follows.flatMap((follow) => [
        follow.field,
        ...Object.keys(follow.match ?? {}),
      ]),
    ];
    const invalid = columns.find((column) => !SQL_IDENT.test(column));
    if (taken.has(table) || invalid !== undefined) {
      omitted.push({
        resource: source,
        reason:
          invalid === undefined
            ? `a resource stream is named ${table}`
            : `${invalid} is not a column name`,
      });
      continue;
    }
    if (spec.user !== undefined) {
      queries.push(
        `SELECT * FROM ${from} WHERE ${dialect.column(table, spec.user)} = ${dialect.user}`,
      );
    }
    for (const follow of follows) {
      const { ids, gaps } = permitted(follow.resource);
      for (const gap of gaps) {
        warnings.push(`${source} under-syncs: ${gap}`);
      }
      if (ids === undefined) {
        warnings.push(
          `${source} does not sync the rows of ${follow.resource}: no grant of its read permission compiles, or it has a deny grant`,
        );
        continue;
      }
      const match = Object.entries(follow.match ?? {}).map(
        ([column, value]) =>
          `${dialect.column(table, column)} = ${dialect.literal(value)}`,
      );
      for (const query of ids) {
        queries.push(
          `SELECT * FROM ${from} WHERE ${[`${dialect.column(table, follow.field)} IN (${query})`, ...match].join(" AND ")}`,
        );
      }
    }
    if (queries.length === 0) {
      omitted.push({ resource: source, reason: "no query compiles" });
      continue;
    }
    streams.push(
      spec.user !== undefined && follows.length === 0
        ? { name: table, table, user: spec.user, queries }
        : { name: table, table, queries },
    );
  }
  return { streams, warnings, omitted };
}
