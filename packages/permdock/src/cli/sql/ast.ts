import { parse } from "pgsql-parser";

import { isRecord } from "../../core/compact.ts";

/** One statement of a SQL file: its parse node and where it sits in the text. */
export interface SqlNode {
  /** The node kind, such as `CreatePolicyStmt` or `IndexStmt`. */
  readonly kind: string;
  /** The node libpg_query returned for the kind. */
  readonly node: Readonly<Record<string, unknown>>;
  /** String index of the first character, past leading comments and white space. */
  readonly start: number;
  /** String index just past the last character, before the `;`. */
  readonly end: number;
  /** 1-based line of `start`. */
  readonly line: number;
  /** The source text of `start` to `end`. */
  readonly text: string;
}

/**
 * Maps the byte offsets libpg_query reports onto string indices, so every range
 * this layer returns indexes the JavaScript string.
 */
export function charIndex(text: string): (byte: number) => number {
  if (Buffer.byteLength(text) === text.length) {
    return (byte) => byte;
  }
  const map: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index) ?? 0;
    const size = Buffer.byteLength(String.fromCodePoint(code));
    for (let byte = 0; byte < size; byte += 1) {
      map.push(index);
    }
    if (code > 0xff_ff) {
      index += 1;
    }
  }
  map.push(text.length);
  return (byte) => map[byte] ?? text.length;
}

/** The index of the first character that is neither white space nor a comment. */
function skipTrivia(text: string, from: number, to: number): number {
  let at = from;
  while (at < to) {
    const char = text[at];
    if (char !== undefined && /\s/u.test(char)) {
      at += 1;
    } else if (char === "-" && text[at + 1] === "-") {
      const end = text.indexOf("\n", at);
      at = end === -1 || end > to ? to : end + 1;
    } else if (char === "/" && text[at + 1] === "*") {
      let depth = 1;
      let cursor = at + 2;
      while (cursor < to && depth > 0) {
        if (text[cursor] === "/" && text[cursor + 1] === "*") {
          depth += 1;
          cursor += 2;
        } else if (text[cursor] === "*" && text[cursor + 1] === "/") {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      at = cursor;
    } else {
      break;
    }
  }
  return at;
}

/**
 * Parses a SQL file into statements with typed nodes and string ranges.
 *
 * @throws {SqlSyntaxError} When libpg_query rejects the file; it names the line
 *   and column.
 */
export async function parseSqlFile(text: string): Promise<readonly SqlNode[]> {
  let result: Awaited<ReturnType<typeof parse>>;
  try {
    result = await parse(text);
  } catch (error) {
    throw syntaxError(text, error);
  }
  const at = charIndex(text);
  const nodes: SqlNode[] = [];
  let line = 1;
  let counted = 0;
  for (const entry of result.stmts ?? []) {
    const wrapper: unknown = entry.stmt;
    if (!isRecord(wrapper)) {
      continue;
    }
    const kind = Object.keys(wrapper)[0];
    const node = kind === undefined ? undefined : wrapper[kind];
    if (kind === undefined || !isRecord(node)) {
      continue;
    }
    const from = at(entry.stmt_location ?? 0);
    const to =
      entry.stmt_len === undefined || entry.stmt_len === 0
        ? text.length
        : at((entry.stmt_location ?? 0) + entry.stmt_len);
    const start = skipTrivia(text, from, to);
    let end = to;
    while (end > start && /\s/u.test(text[end - 1] ?? "x")) {
      end -= 1;
    }
    if (text[end - 1] === ";") {
      end -= 1;
    }
    for (let cursor = counted; cursor < start; cursor += 1) {
      if (text[cursor] === "\n") {
        line += 1;
      }
    }
    counted = start;
    nodes.push({ kind, node, start, end, line, text: text.slice(start, end) });
  }
  return nodes;
}

/** A parse failure with the position libpg_query reported. */
export class SqlSyntaxError extends Error {
  public readonly line: number;
  public readonly column: number;

  public constructor(message: string, line: number, column: number) {
    super(`${message} (line ${String(line)}, column ${String(column)})`);
    this.name = "SqlSyntaxError";
    this.line = line;
    this.column = column;
  }
}

function syntaxError(text: string, error: unknown): SqlSyntaxError {
  const details: unknown = isRecord(error) ? error["sqlDetails"] : undefined;
  const cursor =
    isRecord(details) && typeof details["cursorPosition"] === "number"
      ? details["cursorPosition"]
      : 0;
  // `cursorPosition` is 1-based in characters of the query.
  const before = text.slice(0, Math.max(0, cursor - 1));
  const line = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n");
  const message =
    isRecord(details) && typeof details["message"] === "string"
      ? details["message"]
      : error instanceof Error
        ? error.message
        : "invalid SQL";
  return new SqlSyntaxError(message, line, column);
}

/** The index just past the `;` that ends a statement, and one newline after it. */
function afterTerminator(text: string, end: number): number {
  let at = end;
  while (at < text.length && /[^\S\n]/u.test(text[at] ?? "x")) {
    at += 1;
  }
  if (text[at] === ";") {
    at += 1;
  }
  while (at < text.length && /[^\S\n]/u.test(text[at] ?? "x")) {
    at += 1;
  }
  return text[at] === "\n" ? at + 1 : at;
}

/**
 * `text` without the statements `predicate` selects, each with its `;` and line
 * break.
 */
export function removeStatements(
  text: string,
  statements: readonly SqlNode[],
  predicate: (statement: SqlNode) => boolean,
): string {
  let out = "";
  let cursor = 0;
  for (const statement of statements) {
    if (!predicate(statement)) {
      continue;
    }
    out += text.slice(cursor, statement.start);
    cursor = afterTerminator(text, statement.end);
  }
  return out + text.slice(cursor);
}

/** `text` with one statement's source replaced by `sql` (its `;` stays). */
export function replaceStatement(
  text: string,
  statement: SqlNode,
  sql: string,
): string {
  return text.slice(0, statement.start) + sql + text.slice(statement.end);
}
