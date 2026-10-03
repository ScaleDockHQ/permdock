function blankComments(sql: string): string {
  return sql
    .replaceAll(/--[^\n]*/gu, (comment) => ' '.repeat(comment.length))
    .replaceAll(/\/\*[\s\S]*?\*\//gu, (comment) =>
      comment.replaceAll(/[^\n]/gu, ' '),
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
    if (trimmed !== '') {
      statements.push({
        line: text.slice(0, start + lead).split('\n').length,
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
    if (char === '$') {
      const tag = /^\$[A-Za-z_]*\$/u.exec(text.slice(index, index + 64));
      if (tag !== null) {
        const end = text.indexOf(tag[0], index + tag[0].length);
        index = end === -1 ? text.length : end + tag[0].length;
        continue;
      }
    }
    if (char === ';') {
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
  return match[index] ?? '';
}
