import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { shortDiff } from "./text-diff.ts";

/** One generated file: `part` names it in drift reports, `rel` is relative to the working directory, `-` for stdout. */
export type SqlFile = {
  readonly part: string;
  readonly rel: string;
  readonly text: string;
};

export const STDOUT = "-";

/** `--check`: one entry per file that is missing or differs, naming its part; a differing file carries a short diff. */
export function driftOf(cwd: string, files: readonly SqlFile[]): string[] {
  const drift: string[] = [];
  for (const file of files) {
    if (file.rel === STDOUT) {
      continue;
    }
    const path = resolve(cwd, file.rel);
    if (!existsSync(path)) {
      drift.push(`${file.part}: missing ${file.rel}`);
    } else {
      const onDisk = readFileSync(path, "utf8");
      if (onDisk !== file.text) {
        drift.push(
          `${file.part}: ${file.rel}\n${shortDiff(file.rel, onDisk, file.text)}`,
        );
      }
    }
  }
  return drift;
}

/** Writes every file but the stdout ones, whose text it returns for printing. */
export function writeSqlFiles(
  cwd: string,
  files: readonly SqlFile[],
): { readonly wrote: readonly string[]; readonly printed: string } {
  const wrote: string[] = [];
  const printed: string[] = [];
  for (const file of files) {
    if (file.rel === STDOUT) {
      printed.push(file.text.trimEnd());
      continue;
    }
    const path = resolve(cwd, file.rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.text);
    wrote.push(file.rel);
  }
  return { wrote, printed: printed.join("\n") };
}

const PARTS = ["helpers", "seeds", "indexes", "policies", "hook"] as const;

export type SplitPart = (typeof PARTS)[number];

/** `--split helpers,seeds,indexes,policies,hook`: the parts in that fixed order, or an error. */
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
  const unknown = names.filter((name) => !PARTS.some((part) => part === name));
  if (unknown.length > 0 || names.length === 0) {
    return `rls generate --split takes helpers, seeds, indexes, policies and hook, got '${raw}'`;
  }
  return PARTS.filter((part) => names.includes(part));
}

/** The path of one split part: `{part}` in `out` replaced by the part name. */
export function partPath(out: string, part: SplitPart): string {
  return out.replaceAll("{part}", part);
}

/**
 * pg-delta's per-schema, unnumbered layout: pg-delta orders statements by
 * their dependencies, so no file needs a number to apply first.
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
