import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { dateAt } from "../../core/time.ts";
import { applyFiles } from "./files.ts";
import { shortDiff } from "./text-diff.ts";

/**
 * One generated file: `part` names it in drift reports, `rel` is relative to
 * the working directory, `-` for stdout.
 */
export type OutputFile = {
  readonly part: string;
  readonly rel: string;
  readonly text: string;
};

export const STDOUT = "-";

/** How `path` on disk differs from `expected`; `undefined` when `same` holds. */
export function fileDrift(
  path: string,
  expected: string,
  same: (onDisk: string, expected: string) => boolean = (a, b) => a === b,
):
  | { readonly kind: "missing" }
  | { readonly kind: "differs"; readonly onDisk: string }
  | undefined {
  if (!existsSync(path)) {
    return { kind: "missing" };
  }
  const onDisk = readFileSync(path, "utf8");
  return same(onDisk, expected) ? undefined : { kind: "differs", onDisk };
}

/**
 * `--check`: one entry per file that is missing or differs, naming its part; a
 * differing file carries a short diff.
 */
export function driftOf(cwd: string, files: readonly OutputFile[]): string[] {
  const drift: string[] = [];
  for (const file of files) {
    if (file.rel === STDOUT) {
      continue;
    }
    const found = fileDrift(resolve(cwd, file.rel), file.text);
    if (found?.kind === "missing") {
      drift.push(`${file.part}: missing ${file.rel}`);
    } else if (found?.kind === "differs") {
      drift.push(
        `${file.part}: ${file.rel}\n${shortDiff(file.rel, found.onDisk, file.text)}`,
      );
    }
  }
  return drift;
}

/**
 * Writes every file but the stdout ones, all or nothing, and returns the stdout
 * text for printing.
 */
export function writeOutputFiles(
  cwd: string,
  files: readonly OutputFile[],
): { readonly wrote: readonly string[]; readonly printed: string } {
  const onDisk = files.filter((file) => file.rel !== STDOUT);
  applyFiles(
    cwd,
    onDisk.map((file) => ({ path: file.rel, text: file.text })),
  );
  return {
    wrote: onDisk.map((file) => file.rel),
    printed: files
      .filter((file) => file.rel === STDOUT)
      .map((file) => file.text.trimEnd())
      .join("\n"),
  };
}

export const SPLIT_PARTS = [
  "helpers",
  "seeds",
  "indexes",
  "policies",
  "hook",
] as const;

export type SplitPart = (typeof SPLIT_PARTS)[number];

/**
 * `--split helpers,seeds,indexes,policies,hook`: the parts in that fixed order,
 * or an error.
 */
export function parseSplit(
  raw: string | undefined,
): readonly SplitPart[] | string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const unknown = names.filter(
    (name) => !SPLIT_PARTS.some((part) => part === name),
  );
  if (unknown.length > 0 || names.length === 0) {
    return `rls generate --split takes helpers, seeds, indexes, policies and hook, got '${raw}'`;
  }
  return SPLIT_PARTS.filter((part) => names.includes(part));
}

/** The path of one split part: `{part}` in `out` replaced by the part name. */
export function partPath(out: string, part: SplitPart): string {
  return out.replaceAll("{part}", part);
}

/**
 * pg-delta's per-schema, unnumbered layout: pg-delta orders statements by their
 * dependencies, so no file needs a number to apply first.
 */
export function pgDeltaPath(
  root: string,
  part: SplitPart,
  schema: string,
): string {
  switch (part) {
    case "helpers":
    case "indexes":
    case "seeds":
      return `${root}/${schema}/${part}.sql`;
    case "policies":
      return `${root}/public/policies/permdock.sql`;
    case "hook":
      return `${root}/${schema}/functions/custom_access_token_hook.sql`;
    default: {
      const exhaustive: never = part;
      return exhaustive;
    }
  }
}

/**
 * Whether `--seeds-out` names a migrations directory: it ends with \`/\` or is
 * an existing directory.
 */
export function isSeedsDirectory(cwd: string, out: string): boolean {
  if (out === STDOUT) {
    return false;
  }
  if (out.endsWith("/")) {
    return true;
  }
  const path = resolve(cwd, out);
  return existsSync(path) && statSync(path).isDirectory();
}

/**
 * A generated data migration at `out`: a file, `-` for stdout, or a migrations
 * directory that gets a new versioned file only when the newest one starting
 * with `marker` differs. With `check`, the planned file is always returned, so
 * drift names it. `reserved` lists the files this run already plans, so two
 * data migrations never share a version.
 */
export function dataMigrationFile(input: {
  readonly cwd: string;
  readonly out: string;
  readonly part: string;
  readonly marker: string;
  readonly text: string;
  readonly now: Date;
  readonly check: boolean;
  readonly reserved?: readonly string[];
}): OutputFile | undefined {
  if (!isSeedsDirectory(input.cwd, input.out)) {
    return { part: input.part, rel: input.out, text: input.text };
  }
  const planned = seedsMigration(
    input.cwd,
    input.out,
    input.marker,
    input.text,
    input.now,
    input.part,
    input.reserved,
  );
  return !planned.current || input.check
    ? { part: input.part, rel: planned.rel, text: input.text }
    : undefined;
}

/** `YYYYMMDDHHMMSS` in UTC, the Supabase migration version. */
export function migrationVersion(now: Date): string {
  return now
    .toISOString()
    .replaceAll(/[^0-9]/gu, "")
    .slice(0, 14);
}

const VERSION_PREFIX = /^\d{14}(?=_)/u;

/**
 * The version of a new migration that sorts after every migration in `names`:
 * one second past the newest, so the same directory always gives the same name.
 * Only a directory with no versioned migration falls back to `now`.
 */
export function nextMigrationVersion(
  names: readonly string[],
  now: Date,
): string {
  const times = names.flatMap((name) => {
    const stamp = VERSION_PREFIX.exec(name)?.[0];
    return stamp === undefined
      ? []
      : [
          Date.UTC(
            Number(stamp.slice(0, 4)),
            Number(stamp.slice(4, 6)) - 1,
            Number(stamp.slice(6, 8)),
            Number(stamp.slice(8, 10)),
            Number(stamp.slice(10, 12)),
            Number(stamp.slice(12, 14)),
          ),
        ];
  });
  return times.length === 0
    ? migrationVersion(now)
    : migrationVersion(
        dateAt({ epochMilliseconds: Math.max(...times) + 1000 }),
      );
}

/**
 * The seeds part in a migrations directory: the newest migration there that
 * starts with \`marker\` when its text is \`text\` already, otherwise a new
 * \`<version>_permdock_seeds.sql\` one second after the newest migration
 * (\`nextMigrationVersion\`), so a regeneration of the same directory names it
 * the same. \`current\` is false when a new one is due. \`label\` replaces
 * \`seeds\` in the file name for the other generated data migrations.
 * \`reserved\` holds paths, relative to \`cwd\`, that this run writes; the ones
 * in \`dir\` count as migrations already there.
 */
export function seedsMigration(
  cwd: string,
  dir: string,
  marker: string,
  text: string,
  now: Date,
  label = "seeds",
  reserved: readonly string[] = [],
): { readonly rel: string; readonly current: boolean } {
  const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  const path = resolve(cwd, base);
  const latest = existsSync(path)
    ? readdirSync(path)
        .filter((name) => name.endsWith(".sql"))
        .toSorted()
        .toReversed()
        .find((name) =>
          readFileSync(resolve(path, name), "utf8").startsWith(marker),
        )
    : undefined;
  if (
    latest !== undefined &&
    readFileSync(resolve(path, latest), "utf8") === text
  ) {
    return { rel: `${base}/${latest}`, current: true };
  }
  const names = [
    ...(existsSync(path) ? readdirSync(path) : []),
    ...reserved
      .filter((rel) => resolve(cwd, dirname(rel)) === path)
      .map((rel) => basename(rel)),
  ];
  return {
    rel: `${base}/${nextMigrationVersion(names, now)}_permdock_${label}.sql`,
    current: false,
  };
}
