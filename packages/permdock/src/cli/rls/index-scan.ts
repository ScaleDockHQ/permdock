import { readFileSync } from "node:fs";

import type { IndexTarget } from "./indexes.ts";

import { sqlFiles } from "../files.ts";
import { MIGRATION_DIRS } from "../shared/constants.ts";

/**
 * An index PermDock generated (`permdock_<table>_<columns>_idx`), in the
 * indexes part or in a migration derived from it: it never counts as serving
 * its own target.
 */
const GENERATED_INDEX =
  /\bcreate\s+index\s+(?:if\s+not\s+exists\s+)?"?permdock_\w*_idx"?[^;]*;/giu;
const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const NAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;
const CREATE_INDEX = new RegExp(
  String.raw`\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:${IDENT}\s+)?on\s+(?:only\s+)?(${NAME})\s*(?:using\s+\w+\s*)?\(`,
  "giu",
);
const ADD_KEY = new RegExp(
  String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${NAME})\s+add\s+(?:constraint\s+${IDENT}\s+)?(?:unique|primary\s+key)\s*(?:nulls\s+not\s+distinct\s*)?\(`,
  "giu",
);
const CREATE_TABLE = new RegExp(
  String.raw`\bcreate\s+(?:unlogged\s+|temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?(${NAME})\s*\(`,
  "giu",
);
const TABLE_NAME = new RegExp(
  String.raw`\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(${NAME})`,
  "giu",
);
const TABLE_KEY = new RegExp(
  String.raw`^(?:constraint\s+${IDENT}\s+)?(?:unique|primary\s+key)\s*(?:nulls\s+not\s+distinct\s*)?\(`,
  "iu",
);
const COLUMN_KEY = new RegExp(
  String.raw`^(${IDENT})\s+[^,]*?\b(?:primary\s+key|unique)\b`,
  "iu",
);
const NOT_A_COLUMN = /^(?:constraint|check|foreign|exclude|like)\b/iu;

function bare(part: string): string {
  const trimmed = part.trim();
  return trimmed.startsWith('"')
    ? trimmed.slice(1, -1).replaceAll('""', '"')
    : trimmed.toLowerCase();
}

/** `schema.table`, with `public` for an unqualified name. */
function qualified(raw: string): string {
  const parts = raw.split(".").map(bare);
  return parts.length === 1 ? `public.${parts.join("")}` : parts.join(".");
}

function stripComments(sql: string): string {
  return sql
    .replaceAll(/\/\*[\s\S]*?\*\//gu, " ")
    .replaceAll(/--[^\n]*/gu, " ");
}

/**
 * The text between the `(` that ends `match` and its closing `)`, and the index
 * after it.
 */
function group(
  text: string,
  open: number,
): { body: string; end: number } | undefined {
  let depth = 1;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" || char === '"') {
      const close = text.indexOf(char, index + 1);
      if (close === -1) {
        return undefined;
      }
      index = close;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return { body: text.slice(open, index), end: index + 1 };
      }
    }
  }
  return undefined;
}

function splitTop(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "'" || char === '"') {
      index = Math.max(body.indexOf(char, index + 1), index);
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      items.push(body.slice(from, index));
      from = index + 1;
    }
  }
  items.push(body.slice(from));
  return items.map((item) => item.trim());
}

/** The first capture group of a match; every pattern here captures it. */
function captured(match: RegExpMatchArray): string {
  return match.slice(1, 2).join("");
}

/** The index just past a match. */
function endOf(match: RegExpExecArray): number {
  return match.index + match[0].length;
}

/** The plain key columns of an index column list, cut at the first expression. */
function keyColumns(body: string): string[] {
  const columns: string[] = [];
  for (const item of splitTop(body)) {
    const match = new RegExp(`^(${IDENT})(?:\\s|$)`, "u").exec(item);
    if (match === null || item.startsWith("(")) {
      break;
    }
    columns.push(bare(captured(match)));
  }
  return columns;
}

/**
 * Key columns of each index, unique constraint and primary key the SQL creates,
 * per `schema.table`.
 */
export function indexKeysFromSql(
  sql: string,
): Readonly<Record<string, readonly (readonly string[])[]>> {
  const text = stripComments(sql);
  const keys: Record<string, string[][]> = {};
  const add = (table: string, columns: string[]): void => {
    if (columns.length > 0) {
      (keys[qualified(table)] ??= []).push(columns);
    }
  };
  for (const pattern of [CREATE_INDEX, ADD_KEY]) {
    for (const match of text.matchAll(pattern)) {
      const open = endOf(match);
      const found = group(text, open);
      if (found !== undefined) {
        add(captured(match), keyColumns(found.body));
      }
    }
  }
  for (const match of text.matchAll(CREATE_TABLE)) {
    const found = group(text, endOf(match));
    if (found === undefined) {
      continue;
    }
    for (const item of splitTop(found.body)) {
      if (TABLE_KEY.test(item)) {
        const open = item.indexOf("(") + 1;
        const inner = group(item, open);
        if (inner !== undefined) {
          add(captured(match), keyColumns(inner.body));
        }
      } else if (!NOT_A_COLUMN.test(item)) {
        const column = COLUMN_KEY.exec(item)?.[1];
        if (column !== undefined) {
          add(captured(match), [bare(column)]);
        }
      }
    }
  }
  return keys;
}

/**
 * The index keys of the SQL files under the migration and schema folders of
 * `cwd`.
 */
export function indexKeysFromProject(
  cwd: string,
): Readonly<Record<string, readonly (readonly string[])[]>> {
  const all: Record<string, (readonly string[])[]> = {};
  for (const file of sqlFiles(cwd, [...MIGRATION_DIRS])) {
    const keys = indexKeysFromSql(
      readFileSync(file, "utf8").replaceAll(GENERATED_INDEX, ""),
    );
    for (const [table, list] of Object.entries(keys)) {
      (all[table] ??= []).push(...list);
    }
  }
  return all;
}

/** Every `schema.table` the SQL creates, temporary tables left out. */
export function tablesFromSql(sql: string): ReadonlySet<string> {
  return new Set(
    [...stripComments(sql).matchAll(TABLE_NAME)].map((match) =>
      qualified(captured(match)),
    ),
  );
}

/**
 * Every `schema.table` the SQL files under the migration and schema folders of
 * `cwd` create.
 */
export function tablesFromProject(cwd: string): ReadonlySet<string> {
  const all = new Set<string>();
  for (const file of sqlFiles(cwd, [...MIGRATION_DIRS])) {
    for (const table of tablesFromSql(readFileSync(file, "utf8"))) {
      all.add(table);
    }
  }
  return all;
}

/**
 * The targets no index in `keys` leads with: its key columns start with the
 * target's, as `pruneIndexTargets` reads a database.
 */
export function withoutServedTargets(
  targets: readonly IndexTarget[],
  keys: Readonly<Record<string, readonly (readonly string[])[]>>,
): readonly IndexTarget[] {
  return targets.filter(
    (target) =>
      !(keys[target.table] ?? []).some((key) =>
        target.columns.every((column, at) => key[at] === column),
      ),
  );
}
