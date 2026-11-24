const IDENT_CHAR = /[\p{L}\p{N}_$\u0080-\uFFFF]/u;
const DOLLAR_TAG =
  /^\$(?:[\p{L}_\u0080-\uFFFF][\p{L}\p{N}_\u0080-\uFFFF]*)?\$/u;

/** The index just past a block comment that starts at `from`; they nest. */
function blockCommentEnd(sql: string, from: number): number {
  let depth = 1;
  let at = from + 2;
  while (at < sql.length && depth > 0) {
    if (sql[at] === "/" && sql[at + 1] === "*") {
      depth += 1;
      at += 2;
    } else if (sql[at] === "*" && sql[at + 1] === "/") {
      depth -= 1;
      at += 2;
    } else {
      at += 1;
    }
  }
  return at;
}

/**
 * The index just past a quoted run that opens at `from`. A doubled quote is an
 * escaped quote; a backslash escapes only when `backslash` is set (`E'..'`).
 */
function quotedEnd(
  sql: string,
  from: number,
  quote: string,
  backslash: boolean,
): number {
  let at = from + 1;
  while (at < sql.length) {
    if (backslash && sql[at] === "\\") {
      at += 2;
    } else if (sql[at] !== quote) {
      at += 1;
    } else if (sql[at + 1] === quote) {
      at += 2;
    } else {
      return at + 1;
    }
  }
  return sql.length;
}

/** The index just past a dollar-quoted body that opens at `from`, or -1. */
function dollarEnd(sql: string, from: number): number {
  if (IDENT_CHAR.test(sql[from - 1] ?? " ")) {
    return -1;
  }
  const tag = DOLLAR_TAG.exec(sql.slice(from, from + 80))?.[0];
  if (tag === undefined) {
    return -1;
  }
  const end = sql.indexOf(tag, from + tag.length);
  return end === -1 ? sql.length : end + tag.length;
}

/**
 * The statements of `sql` as `text` with comments blanked (same length, so
 * offsets hold) and the index of each `;` between them. A reader that knows
 * Postgres lexing: `--` inside a string is text, a doubled quote and a
 * backslash in an `E''` string escape a quote, `"a;b"` is one identifier,
 * dollar-quoted bodies nest nothing and block comments nest.
 */
function lex(sql: string): { readonly text: string; readonly cuts: number[] } {
  const out = sql.split("");
  const cuts: number[] = [];
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to; at += 1) {
      if (out[at] !== "\n") {
        out[at] = " ";
      }
    }
  };
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    let end = -1;
    if (char === "-" && next === "-") {
      const eol = sql.indexOf("\n", index);
      end = eol === -1 ? sql.length : eol;
      blank(index, end);
    } else if (char === "/" && next === "*") {
      end = blockCommentEnd(sql, index);
      blank(index, end);
    } else if (char === "'") {
      const before = sql[index - 1];
      const escapes =
        (before === "E" || before === "e") &&
        !IDENT_CHAR.test(sql[index - 2] ?? " ");
      end = quotedEnd(sql, index, "'", escapes);
    } else if (char === '"') {
      end = quotedEnd(sql, index, '"', false);
    } else if (char === "$") {
      end = dollarEnd(sql, index);
    } else if (char === ";") {
      cuts.push(index);
    }
    index = end === -1 ? index + 1 : end;
  }
  return { text: out.join(""), cuts };
}

/**
 * Split on `;` outside strings, quoted identifiers, comments and dollar-quoted
 * bodies.
 */
export function sqlStatements(
  sql: string,
): readonly { readonly line: number; readonly text: string }[] {
  const { text, cuts } = lex(sql);
  const statements: { line: number; text: string }[] = [];
  // Statements arrive in order, so count newlines once instead of rescanning the prefix.
  let counted = 0;
  let line = 1;
  let start = 0;
  for (const end of [...cuts, text.length]) {
    const body = text.slice(start, end);
    const trimmed = body.trim();
    if (trimmed !== "") {
      const at = start + (body.length - body.trimStart().length);
      for (let cursor = counted; cursor < at; cursor += 1) {
        if (text[cursor] === "\n") {
          line += 1;
        }
      }
      counted = at;
      statements.push({ line, text: trimmed });
    }
    start = end + 1;
  }
  return statements;
}

/** Capture group `index` of a match, or '' when an optional group took no part. */
export function group(
  match: RegExpExecArray | RegExpMatchArray,
  index: number,
): string {
  return match[index] ?? "";
}

const VIEW =
  /^create\s+(?:or\s+replace\s+)?view\s+(?<name>\S+?)(?:\s+with\s*\((?<options>[^)]*)\))?\s+as\b/iu;
const PRIVILEGE =
  /^(?:grant|revoke)\s[\s\S]*?\son\s+(?<target>[\s\S]+?)\s+(?:to|from)\s/iu;
const UNDIFFED_TARGET =
  /^(?:schema|function|procedure|routine|all\s+(?:functions|procedures|routines)\s+in\s+schema)\s/iu;

function privilegeTable(target: string): string {
  return target.replace(/^table\s+/iu, "").trim();
}

export function splitUndiffed(sql: string): {
  readonly kept: string;
  readonly moved: readonly string[];
} {
  const statements = sqlStatements(sql);
  const views = new Set<string>();
  const moved: string[] = [];
  let kept = sql;
  for (const { text } of statements) {
    const view = VIEW.exec(text)?.groups;
    if (view !== undefined) {
      views.add(view["name"] ?? "");
      if (view["options"] !== undefined) {
        moved.push(
          `alter view ${view["name"] ?? ""} set (${view["options"]});`,
        );
      }
      continue;
    }
    const target = PRIVILEGE.exec(text)?.groups?.["target"];
    if (
      target !== undefined &&
      (UNDIFFED_TARGET.test(target) || views.has(privilegeTable(target)))
    ) {
      moved.push(`${text};`);
      kept = kept.replace(`${text};\n`, "");
    }
  }
  return { kept, moved };
}
