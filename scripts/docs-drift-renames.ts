import { globSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  RENAMES_0_5,
  type Rename,
  // oxlint-disable-next-line import/no-relative-parent-imports -- Node strips the types, so the drift check reads the codemod map without a build
} from "../packages/permdock/src/cli/codemod/renames-0.5.ts";
import {
  RENAMED_HEADING,
  renamedSectionDrift,
  tableRows,
} from "./docs-drift-renamed-section.ts";

type RenameDriftPaths = {
  readonly root: string;
  readonly docPages: readonly string[];
  readonly namingPage: string;
  /** The `cli/codemod.mdx` page, which shows the old names on purpose. */
  readonly codemodPage: string;
  readonly exportsFile: string;
};

/** Sections of the Naming page that list former names. */
const RENAMED_SECTIONS = new Set([RENAMED_HEADING, "## Renamed before 0.1.0"]);

/**
 * Former wire values: `typ` strings, the CloudEvents type prefix and the SCIM
 * group extension URN.
 */
const OLD_WIRE_VALUES: readonly string[] = [
  "permdock-snapshot+jwt",
  "permdock-approval+jwt",
  "permdock-policy+jwt",
  "permdock-capability+jwt",
  "permdock-decisions+jwt",
  "dev.permdock.",
  "urn:permdock:scim:schemas:extension:roles:1.0",
];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Former export and type names from the 0.5 rename map. A name some entry still
 * exports at run time stays allowed; option and method rows are ordinary words
 * (`store`, `source`, `permdock`) and never banned.
 */
function oldIdentifiers(exportsFile: string): readonly string[] {
  // SAFETY: exports.json is the bundle test's own baseline, entry to sorted runtime export names
  const exported = JSON.parse(read(exportsFile)) as Readonly<
    Record<string, readonly string[]>
  >;
  const current = new Set(Object.values(exported).flat());
  const names = RENAMES_0_5.filter(
    (row) =>
      row.kind === undefined || row.kind === "export" || row.kind === "type",
  )
    .map((row) => row.from)
    .filter((name) => !current.has(name));
  return [...new Set(names)].toSorted();
}

/**
 * The text a reader sees as code: fenced blocks and inline code spans, with
 * each line's number.
 */
function codeLines(text: string): readonly (readonly [number, string])[] {
  const out: (readonly [number, string])[] = [];
  let fenced = false;
  for (const [index, line] of text.split("\n").entries()) {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      out.push([index + 1, line]);
      continue;
    }
    const spans: string[] = [];
    for (const [, span = ""] of line.matchAll(/`([^`]+)`/gu)) {
      spans.push(span);
    }
    if (spans.length > 0) {
      out.push([index + 1, spans.join(" ")]);
    }
  }
  return out;
}

/**
 * The Naming page with the sections that list former names blanked, keeping
 * line numbers.
 */
function withoutRenamedSections(text: string): string {
  let skipping = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("## ")) {
        skipping = RENAMED_SECTIONS.has(line.trim());
      }
      return skipping ? "" : line;
    })
    .join("\n");
}

/** Old 0.5 names and wire values in docs code fences and inline code. */
function oldNames(paths: RenameDriftPaths): readonly string[] {
  const identifiers = oldIdentifiers(paths.exportsFile).map(
    (name) =>
      [
        name,
        // `>` before a name is a placeholder such as `<provider>RoleSource`, not the old name
        new RegExp(`(?<![\\w$>])${RegExp.escape(name)}(?![\\w$])`, "u"),
      ] as const,
  );
  const found: string[] = [];
  for (const page of paths.docPages) {
    if (page === paths.codemodPage) {
      continue;
    }
    const text =
      page === paths.namingPage
        ? withoutRenamedSections(read(page))
        : read(page);
    const where = relative(paths.root, page);
    for (const [line, code] of codeLines(text)) {
      for (const [name, pattern] of identifiers) {
        if (pattern.test(code)) {
          found.push(`${where}:${line} uses ${name}, renamed in 0.5.0`);
        }
      }
      for (const value of OLD_WIRE_VALUES) {
        if (code.includes(value)) {
          found.push(`${where}:${line} uses ${value}, a former wire value`);
        }
      }
    }
  }
  return found;
}

/**
 * The names a cell can mean: the code span itself, and its last identifier
 * (`scimHandler({ store })` is `store`).
 */
function cellNames(cell: string): readonly string[] {
  const code = cell.replaceAll("`", "").trim();
  const last = [...code.matchAll(/[A-Za-z_$][\w$]*/gu)].at(-1)?.[0];
  return last === undefined || last === code ? [code] : [code, last];
}

function rowMatches(row: Rename, old: string, next: string): boolean {
  return cellNames(old).includes(row.from) && cellNames(next).includes(row.to);
}

/**
 * Every `.changeset/rename-*.md` `| Old | New |` row is a codemod map row, and
 * every map row is in one or in a released `packages/permdock/CHANGELOG.md`
 * table, where versioning moves them.
 */
function changesetRenames(root: string): readonly string[] {
  const dir = join(root, ".changeset");
  const problems: string[] = [];
  const all: (readonly [string, string])[] = tableRows(
    read(join(root, "packages/permdock/CHANGELOG.md")),
    "Old",
    "New",
  ).map(([old = "", next = ""]): readonly [string, string] => [old, next]);
  for (const name of globSync("rename-*.md", { cwd: dir }).toSorted()) {
    const text = read(join(dir, name));
    for (const [old = "", next = ""] of tableRows(text, "Old", "New")) {
      all.push([old, next]);
      if (!RENAMES_0_5.some((row) => rowMatches(row, old, next))) {
        problems.push(
          `.changeset/${name} renames ${old} to ${next}, which renames-0.5.ts does not list`,
        );
      }
    }
  }
  for (const row of RENAMES_0_5) {
    if (!all.some(([old, next]) => rowMatches(row, old, next))) {
      problems.push(
        `renames-0.5.ts renames ${row.from} to ${row.to} (${row.entries.join(", ")}), which no .changeset/rename-*.md or CHANGELOG.md table lists`,
      );
    }
  }
  return problems;
}

/**
 * Old names in the docs, changeset tables against the codemod map, and the
 * Naming page section against it.
 */
export function renameDrift(paths: RenameDriftPaths): readonly string[] {
  return [
    ...oldNames(paths),
    ...changesetRenames(paths.root),
    ...renamedSectionDrift(paths.namingPage),
  ];
}
