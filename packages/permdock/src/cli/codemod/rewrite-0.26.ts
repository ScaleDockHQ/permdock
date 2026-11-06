import type { SqlCommand } from "../../core/sql.ts";
import type { CodemodChange, CodemodFollowUp } from "./context.ts";

import { defaultSqlCommand } from "../../core/sql.ts";

export type RewriteResult = {
  readonly source: string;
  readonly changes: readonly CodemodChange[];
  readonly followUps: readonly CodemodFollowUp[];
};

const ROW_CALL = /\bpermitted_([a-z][a-z0-9_]*)_row\s*\(/gu;
const TEXT_BEFORE_HELPER =
  /::text(?=\s+in\s*\(\s*select\b[^)]{0,120}\b(?:permitted_|can_|member_|permdock_))/gu;
const TEXT_AFTER_HELPER =
  /(\b(?:permitted_|can_|member_|permdock_)[a-z0-9_]*\s*\([^;]{0,200}?\))::text/gu;
const OWN_SUBJECT = /\bown_subject\s*\(\s*\)/gu;
const TABLE_OF =
  /(^[ \t]*)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{\s*tableOf\s*:\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\3\s*\},?[ \t]*\r?\n/gmu;
const VERB_PREFIX =
  /^(read|list|get|create|duplicate|update|delete|remove|approve|reject|cancel|send|withdraw|confirm|fulfill|receive|reimburse|writeOff|mark|pause|resume)(?=[A-Z0-9_-])/u;
const ACTION_LINE =
  /^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(['"])(select|insert|update|delete)\3,?[ \t]*\r?\n/gmu;
const PROPERTY = (key: string): RegExp =>
  new RegExp(String.raw`(?<![A-Za-z0-9_])${key}\s*:`, "gu");

function change(from: string, to: string): CodemodChange {
  return { line: 1, column: 0, from, to };
}

function rewriteSql(source: string): {
  text: string;
  changes: CodemodChange[];
} {
  const changes: CodemodChange[] = [];
  let text = source;
  const row = text.match(ROW_CALL);
  if (row !== null) {
    text = text.replaceAll(ROW_CALL, "can_$1(");
    changes.push(change("permitted_<resource>_row(", "can_<resource>("));
  }
  if (TEXT_BEFORE_HELPER.test(text) || TEXT_AFTER_HELPER.test(text)) {
    TEXT_BEFORE_HELPER.lastIndex = 0;
    TEXT_AFTER_HELPER.lastIndex = 0;
    text = text
      .replaceAll(TEXT_BEFORE_HELPER, "")
      .replaceAll(TEXT_AFTER_HELPER, "$1");
    changes.push(change("::text", ""));
  }
  if (OWN_SUBJECT.test(text)) {
    OWN_SUBJECT.lastIndex = 0;
    text = text.replaceAll(OWN_SUBJECT, "");
    changes.push(change("own_subject()", ""));
  }
  return { text, changes };
}

function ownerProperty(source: string, owner: string): RegExpExecArray | null {
  const pattern = new RegExp(
    String.raw`(^[ \t]*)${owner}\s*:\s*(\{[^}\n]*\}|(['"])[^'"\n]*\3),?`,
    "mu",
  );
  return pattern.exec(source);
}

function withAlso(
  property: string,
  child: string,
  owner: string,
): string | undefined {
  const stringValue = new RegExp(
    String.raw`^([ \t]*)${owner}\s*:\s*(['"])([^'"\n]*)\2,?$`,
    "u",
  ).exec(property);
  if (stringValue !== null) {
    const indent = stringValue[1] ?? "";
    const quote = stringValue[2] ?? '"';
    const table = stringValue[3] ?? "";
    return `${indent}${owner}: { table: ${quote}${table}${quote}, also: [${quote}${child}${quote}] },`;
  }
  if (property.includes("also:")) {
    return property.replace(
      /also\s*:\s*\[([^\]]*)\]/u,
      (_match, list: string) => {
        const quote = property.includes("'") ? "'" : '"';
        const item = `${quote}${child}${quote}`;
        const body = list.trim();
        return `also: [${body === "" ? item : `${body}, ${item}`}]`;
      },
    );
  }
  return property.replace(/\{\s*/u, (brace) => `${brace}also: ["${child}"], `);
}

function stringEnd(source: string, open: number): number {
  const quote = source[open];
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === quote) {
      return index;
    }
  }
  return source.length - 1;
}

function matchingClose(source: string, open: number): number {
  const closeOf: Readonly<Record<string, string>> = {
    "{": "}",
    "[": "]",
    "(": ")",
  };
  const stack = [closeOf[source[open] ?? ""] ?? ""];
  for (let index = open + 1; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (char === '"' || char === "'" || char === "`") {
      index = stringEnd(source, index);
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      stack.push(closeOf[char] ?? "");
      continue;
    }
    if (char === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) {
        return index;
      }
    }
  }
  return source.length - 1;
}

function endOfValue(source: string, start: number): number {
  const char = source[start];
  if (char === '"' || char === "'" || char === "`") {
    return stringEnd(source, start) + 1;
  }
  if (char === "{" || char === "[" || char === "(") {
    return matchingClose(source, start) + 1;
  }
  let index = start;
  while (
    index < source.length &&
    source[index] !== "," &&
    source[index] !== "\n" &&
    source[index] !== "}"
  ) {
    index += 1;
  }
  return index;
}

function skipSpace(source: string, index: number): number {
  let cursor = index;
  while (source[cursor] === " " || source[cursor] === "\t") {
    cursor += 1;
  }
  return cursor;
}

function removeProperty(
  source: string,
  key: string,
  when?: (value: string, index: number) => boolean,
): { text: string; removed: boolean } {
  const pattern = PROPERTY(key);
  let text = source;
  let cursor = 0;
  let removed = false;
  while (cursor < text.length) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(text);
    if (match === null) {
      break;
    }
    const valueStart = skipSpace(text, match.index + match[0].length);
    const valueEnd = endOfValue(text, valueStart);
    if (
      when !== undefined &&
      !when(text.slice(valueStart, valueEnd), match.index)
    ) {
      cursor = valueEnd;
      continue;
    }
    let end = valueEnd;
    if (text[end] === ",") {
      end += 1;
    }
    if (text[end] === "\r") {
      end += 1;
    }
    if (text[end] === "\n") {
      end += 1;
    }
    const lineBreak = text.lastIndexOf("\n", match.index - 1);
    const prefix = text.slice(lineBreak + 1, match.index);
    const start = /^[ \t]*$/u.test(prefix) ? lineBreak + 1 : match.index;
    text = text.slice(0, start) + text.slice(end);
    removed = true;
    cursor = start;
  }
  return { text, removed };
}

function inferredOf(action: string): SqlCommand | undefined {
  const exact = defaultSqlCommand(action);
  if (exact !== undefined) {
    return exact;
  }
  const verb = VERB_PREFIX.exec(action)?.[1];
  if (verb === undefined) {
    return undefined;
  }
  if (verb === "mark" || verb === "pause" || verb === "resume") {
    return "update";
  }
  return defaultSqlCommand(verb);
}

function withoutInferred(body: string): { text: string; changed: boolean } {
  let changed = false;
  const text = body.replaceAll(
    ACTION_LINE,
    (line, _indent, name, _quote, value) => {
      if (inferredOf(String(name)) !== value) {
        return line;
      }
      changed = true;
      return "";
    },
  );
  return { text, changed };
}

function dropInferredActions(source: string): {
  text: string;
  changed: boolean;
} {
  const pattern = /\bactions\s*:\s*\{/gu;
  let text = source;
  let cursor = 0;
  let changed = false;
  while (cursor < text.length) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(text);
    if (match === null) {
      break;
    }
    const open = text.indexOf("{", match.index);
    const close = matchingClose(text, open);
    const next = withoutInferred(text.slice(open + 1, close));
    if (!next.changed) {
      cursor = close + 1;
      continue;
    }
    changed = true;
    text = text.slice(0, open + 1) + next.text + text.slice(close);
    cursor = open + 1;
  }
  return { text, changed };
}

function insidePermissions(source: string, index: number): boolean {
  let depth = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = source[cursor];
    if (char === "}") {
      depth += 1;
    } else if (char === "{") {
      if (depth === 0) {
        return /permissions\s*:\s*$/u.test(source.slice(0, cursor));
      }
      depth -= 1;
    }
  }
  return false;
}

function dropSupplied(source: string): {
  text: string;
  changes: CodemodChange[];
} {
  const changes: CodemodChange[] = [];
  const role = removeProperty(source, "roleThrough");
  let text = role.text;
  if (role.removed) {
    changes.push(change("roleThrough", ""));
  }
  const disabled = removeProperty(text, "disabled", (_value, index) =>
    insidePermissions(text, index),
  );
  text = disabled.text;
  if (disabled.removed) {
    changes.push(change("permissions.disabled", ""));
  }
  const assign = removeProperty(text, "canAssign", (value) =>
    value.includes("permdock_can_assign_any"),
  );
  text = assign.text;
  if (assign.removed) {
    changes.push(change("platformRoles.canAssign", ""));
  }
  return { text, changes };
}

/**
 * 0.26 text rewrites: `permitted_<resource>_row(` becomes `can_<resource>(`,
 * `::text` around a helper call is removed, `own_subject()` is deleted, and `{
 * tableOf }` moves onto the owner's `also` list. Inferred `rls.actions` entries
 * are dropped. A `better-supabase.config.*` file loses `roleThrough`,
 * `permissions.disabled` and a `canAssign` that names
 * `permdock_can_assign_any`.
 */
export function rewrite026(file: string, source: string): RewriteResult {
  const sql = rewriteSql(source);
  const followUps: CodemodFollowUp[] = [];
  let text = sql.text;
  const found = [...text.matchAll(TABLE_OF)];
  for (const match of found) {
    const child = match[2] ?? "";
    const owner = match[4] ?? "";
    text = text.replaceAll(match[0], "");
    const property = ownerProperty(text, owner);
    if (property === null) {
      followUps.push({
        line: 1,
        column: 0,
        name: "tableOf",
        message: `${file}: rls.tables.${child}.tableOf names ${owner}, which this file does not declare as a property the codemod can extend`,
      });
      continue;
    }
    const next = withAlso(property[0], child, owner);
    if (next === undefined) {
      continue;
    }
    text = text.replaceAll(property[0], next);
  }
  const changes = [...sql.changes];
  if (found.length > 0) {
    changes.push(change("tableOf", "also"));
  }
  const actions = dropInferredActions(text);
  text = actions.text;
  if (actions.changed) {
    changes.push(change("rls.actions", ""));
  }
  if (file.includes("better-supabase.config.")) {
    const supplied = dropSupplied(text);
    text = supplied.text;
    changes.push(...supplied.changes);
  }
  return { source: text, changes, followUps };
}
