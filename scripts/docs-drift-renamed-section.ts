import { readFileSync } from "node:fs";

export const RENAMED_HEADING = "## Renamed in 0.5.0";

/** Cells of a Markdown table row, trimmed, without the outer pipes. */
function cells(line: string): readonly string[] {
  return line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split(/(?<!\\)\|/u)
    .map((cell) => cell.trim());
}

/**
 * The body rows of every table in `text` whose header starts with `first` and
 * `second`.
 */
export function tableRows(
  text: string,
  first: string,
  second: string,
): readonly (readonly string[])[] {
  const rows: (readonly string[])[] = [];
  let inTable = false;
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) {
      inTable = false;
      continue;
    }
    const row = cells(line);
    if (row[0] === first && row[1] === second) {
      inTable = true;
      continue;
    }
    if (inTable && !row.every((cell) => /^:?-+:?$/u.test(cell))) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * The "Renamed in 0.5.0" section is history. The codemod no longer owns it, so
 * the check only requires the heading.
 */
export function renamedSectionDrift(namingPage: string): readonly string[] {
  const text = readFileSync(namingPage, "utf8");
  return text.includes(RENAMED_HEADING)
    ? []
    : [`getting-started/naming.mdx has no "${RENAMED_HEADING}" section`];
}
