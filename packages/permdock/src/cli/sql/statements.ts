function blankComments(sql: string): string {
  return sql
    .replaceAll(/--[^\n]*/gu, (comment) => " ".repeat(comment.length))
    .replaceAll(/\/\*[\s\S]*?\*\//gu, (comment) =>
      comment.replaceAll(/[^\n]/gu, " "),
    );
}

/** Split on `;` outside string literals and dollar-quoted bodies. */
export function sqlStatements(
  sql: string,
): readonly { readonly line: number; readonly text: string }[] {
  const text = blankComments(sql);
  const statements: { line: number; text: string }[] = [];
  const push = (start: number, end: number): void => {
    const body = text.slice(start, end);
    const lead = body.length - body.trimStart().length;
    const trimmed = body.trim();
    if (trimmed !== "") {
      statements.push({
        line: text.slice(0, start + lead).split("\n").length,
        text: trimmed,
      });
    }
  };
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === "$") {
      const tag = /^\$[A-Za-z_]*\$/u.exec(text.slice(index, index + 64));
      if (tag !== null) {
        const end = text.indexOf(tag[0], index + tag[0].length);
        index = end === -1 ? text.length : end + tag[0].length;
        continue;
      }
    }
    if (char === ";") {
      push(start, index);
      start = index + 1;
    }
    index += 1;
  }
  push(start, text.length);
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
