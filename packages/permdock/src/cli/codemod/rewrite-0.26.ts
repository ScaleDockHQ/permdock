import type { CodemodChange, CodemodFollowUp } from "./context.ts";

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

/**
 * 0.26 text rewrites: `permitted_<resource>_row(` becomes `can_<resource>(`,
 * `::text` around a helper call is removed, `own_subject()` is deleted, and `{
 * tableOf }` moves onto the owner's `also` list.
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
  return { source: text, changes, followUps };
}
