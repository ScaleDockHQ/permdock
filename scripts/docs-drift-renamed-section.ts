import { readFileSync, writeFileSync } from "node:fs";

// oxlint-disable-next-line import/no-relative-parent-imports -- Node strips the types, so the drift check reads the CLI rename table without a build
import type { FlagRename } from "../packages/permdock/src/cli/codemod/cli-renames-0.5.ts";

import {
  COMMAND_MOVES,
  DEFAULT_CHANGES,
  FLAG_RENAMES,
  // oxlint-disable-next-line import/no-relative-parent-imports -- Node strips the types, so the drift check reads the CLI rename table without a build
} from "../packages/permdock/src/cli/codemod/cli-renames-0.5.ts";
import {
  RENAMES_0_5,
  SIGNATURE_CHANGES_0_5,
  // oxlint-disable-next-line import/no-relative-parent-imports -- Node strips the types, so the drift check reads the codemod map without a build
} from "../packages/permdock/src/cli/codemod/renames-0.5.ts";

export const RENAMED_HEADING = "## Renamed in 0.5.0";
const FIX = "run node scripts/check-docs-drift.ts --write-renamed";

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
 * A table padded the way oxfmt pads it, so a generated section passes
 * `format:check`.
 */
function markdownTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = header.map((cell, column) =>
    Math.max(3, cell.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (row: readonly string[]): string =>
    `| ${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  return [
    line(header),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map(line),
  ].join("\n");
}

function code(text: string): string {
  return `\`${text.replaceAll("|", "\\|")}\``;
}

/** A hint as Markdown: flags and commands in code, so `<id>` is not read as JSX. */
function prose(hint: string): string {
  return hint.replaceAll(/permdock [a-z]+|--[a-z-]+(?: <[a-z]+>)?/gu, (match) =>
    code(match),
  );
}

function flagAfter(rename: FlagRename): string {
  if (rename.rewrite !== undefined && rename.rewrite !== "") {
    return code(rename.rewrite);
  }
  if (rename.to === undefined || rename.rewrite === "") {
    return `removed: ${prose(rename.hint ?? "")}`;
  }
  if (rename.hint !== undefined) {
    return rename.hint.startsWith(rename.to)
      ? prose(rename.hint)
      : `${code(rename.to)}: ${prose(rename.hint)}`;
  }
  const values =
    rename.values === undefined
      ? ""
      : `, values ${Object.entries(rename.values)
          .map(
            (pair: readonly [string, string]) =>
              `${code(pair[0])} to ${code(pair[1])}`,
          )
          .join(", ")}`;
  return `${code(rename.to)}${values}`;
}

/** The CLI rows: moved commands, renamed or removed flags, flipped defaults. */
function cliRows(): readonly (readonly string[])[] {
  return [
    ...COMMAND_MOVES.map((move) => [
      code(`permdock ${move.from}`),
      code(`permdock ${move.to}`),
      "",
    ]),
    ...FLAG_RENAMES.map((rename) => [
      code(rename.from),
      flagAfter(rename),
      rename.commands.map(code).join(", "),
    ]),
    ...DEFAULT_CHANGES.map((change) => [
      `no ${change.unless.map(code).join(" or ")}`,
      code(change.add),
      code(change.command),
    ]),
  ];
}

/**
 * The "Renamed in 0.5.0" section of the Naming page, generated from the codemod
 * map.
 */
function renamedSection(): string {
  return [
    RENAMED_HEADING,
    "",
    "`permdock codemod 0.5` applies these renames to every file that imports `permdock` ([codemod](/docs/cli/codemod)). Entries are the imports the old name came from. The codemod reports `method` rows, and `option` rows outside the calls it knows, for a manual edit. `pnpm docs:drift` keeps this section equal to `packages/permdock/src/cli/codemod/renames-0.5.ts`.",
    "",
    markdownTable(
      ["Old", "New", "Kind", "Entries"],
      RENAMES_0_5.map((row) => [
        `\`${row.from}\``,
        `\`${row.to}\``,
        row.kind ?? "export",
        row.entries.map((entry) => `\`${entry}\``).join(", "),
      ]),
    ),
    "",
    "These changed their call shape; the codemod lists each call site:",
    "",
    markdownTable(
      ["Before", "After"],
      SIGNATURE_CHANGES_0_5.map((change) => [
        `\`${change.before}\``,
        `\`${change.after}\``,
      ]),
    ),
    "",
    "The CLI changed these commands and flags. Since 0.17.0 an old spelling exits `2` as an unknown flag or command. `permdock codemod 0.5` rewrites them in `package.json` scripts, CI workflows and shell scripts, and lists them in Markdown:",
    "",
    markdownTable(["CLI before", "CLI after", "Commands"], cliRows()),
    "",
  ].join("\n");
}

/** The section's offsets, from its heading to the next `## ` heading. */
function sectionSpan(text: string): readonly [number, number] | undefined {
  const start = text.indexOf(`\n${RENAMED_HEADING}\n`);
  if (start === -1) {
    return undefined;
  }
  const next = text.indexOf("\n## ", start + RENAMED_HEADING.length + 2);
  return [start + 1, next === -1 ? text.length : next + 1];
}

function sameRows(
  left: string,
  right: string,
  first: string,
  second: string,
): boolean {
  const rows = (text: string): string =>
    tableRows(text, first, second)
      .map((row) => row.join(" | "))
      .join("\n");
  return rows(left) === rows(right);
}

/** The Naming page's "Renamed in 0.5.0" tables equal the codemod map. */
export function renamedSectionDrift(namingPage: string): readonly string[] {
  const text = readFileSync(namingPage, "utf8");
  const span = sectionSpan(text);
  if (span === undefined) {
    return [
      `getting-started/naming.mdx has no "${RENAMED_HEADING}" section; ${FIX}`,
    ];
  }
  const section = text.slice(...span);
  const expected = renamedSection();
  return sameRows(section, expected, "Old", "New") &&
    sameRows(section, expected, "Before", "After") &&
    sameRows(section, expected, "CLI before", "CLI after")
    ? []
    : [
        `getting-started/naming.mdx "${RENAMED_HEADING}" does not match renames-0.5.ts; ${FIX}`,
      ];
}

/**
 * Writes the generated "Renamed in 0.5.0" section; a new one goes before
 * "Renamed before 0.1.0".
 */
export function writeRenamedSection(namingPage: string): void {
  const text = readFileSync(namingPage, "utf8");
  const span = sectionSpan(text);
  const section = renamedSection();
  if (span !== undefined) {
    const rest = text.slice(span[1]);
    writeFileSync(
      namingPage,
      `${text.slice(0, span[0])}${section}${rest === "" ? "" : "\n"}${rest}`,
    );
    return;
  }
  const before = text.indexOf("\n## Renamed before 0.1.0\n");
  const at = before === -1 ? text.length : before + 1;
  writeFileSync(
    namingPage,
    `${text.slice(0, at)}${section}\n${text.slice(at)}`,
  );
}
