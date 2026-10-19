import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { CliError } from "./errors.ts";

/** A file a command writes, relative to the working directory or absolute. */
export type PlannedFile = {
  readonly path: string;
  readonly text: string;
};

export type FileOutcome = "created" | "updated" | "unchanged";

export type AppliedFile = {
  readonly path: string;
  readonly outcome: FileOutcome;
};

function outcomeOf(abs: string, text: string): FileOutcome {
  if (!existsSync(abs)) {
    return "created";
  }
  return readFileSync(abs, "utf8") === text ? "unchanged" : "updated";
}

/** What writing `files` would do, without writing. */
export function planFiles(
  cwd: string,
  files: readonly PlannedFile[],
): readonly AppliedFile[] {
  return files.map((file) => ({
    path: file.path,
    outcome: outcomeOf(resolve(cwd, file.path), file.text),
  }));
}

/**
 * Writes every created or updated file, all or nothing: each one is staged
 * beside its target first, and a failed stage removes the others before
 * anything is replaced. `dryRun` only plans.
 */
export function applyFiles(
  cwd: string,
  files: readonly PlannedFile[],
  options: { readonly dryRun?: boolean } = {},
): readonly AppliedFile[] {
  const planned = planFiles(cwd, files);
  if (options.dryRun === true) {
    return planned;
  }
  const staged: { readonly temp: string; readonly target: string }[] = [];
  try {
    for (const [index, file] of files.entries()) {
      if (planned[index]?.outcome === "unchanged") {
        continue;
      }
      const target = resolve(cwd, file.path);
      const temp = `${target}.permdock-${String(process.pid)}.tmp`;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(temp, file.text);
      staged.push({ temp, target });
    }
  } catch (error) {
    for (const { temp } of staged) {
      rmSync(temp, { force: true });
    }
    throw new CliError(
      "failed",
      `could not write ${describe(error)}; wrote nothing`,
      {
        code: "write_failed",
        cause: error,
      },
    );
  }
  for (const { temp, target } of staged) {
    renameSync(temp, target);
  }
  return planned;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const VERBS: Readonly<Record<FileOutcome, readonly [string, string]>> = {
  created: ["Created", "Would create"],
  updated: ["Updated", "Would update"],
  unchanged: ["Unchanged", "Unchanged"],
};

/** One line per file: `Created x`, or `Would create x` under `--dry-run`. */
export function fileSummary(
  applied: readonly AppliedFile[],
  dryRun: boolean,
): string {
  return applied
    .map((file) => `${VERBS[file.outcome][dryRun ? 1 : 0]} ${file.path}`)
    .join("\n");
}

/**
 * The files among `paths` with uncommitted changes in git. Outside a git
 * work tree, or without git, nothing counts as dirty.
 */
export function dirtyFiles(
  cwd: string,
  paths: readonly string[],
): readonly string[] {
  if (paths.length === 0) {
    return [];
  }
  let status: string;
  try {
    status = execFileSync(
      "git",
      [
        "status",
        "--porcelain",
        "-z",
        "--",
        ...paths.map((path) => resolve(cwd, path)),
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return [];
  }
  let root: string;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return [];
  }
  return status
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => relative(realpathSync(cwd), resolve(root, entry.slice(3))));
}

/**
 * A rewrite of hand-written files stops when one of them has uncommitted
 * changes, so `git diff` shows only what the command changed. `--force`
 * rewrites anyway.
 */
export function refuseDirty(input: {
  readonly command: string;
  /** The command and its arguments, as `next` repeats them: `codemod 0.5 src`. */
  readonly invocation: string;
  readonly cwd: string;
  readonly paths: readonly string[];
  readonly force: boolean;
}): void {
  if (input.force) {
    return;
  }
  const dirty = dirtyFiles(input.cwd, input.paths);
  if (dirty.length === 0) {
    return;
  }
  throw new CliError(
    "action",
    `${input.command} rewrites files with uncommitted changes: ${dirty.join(", ")}. Commit or stash them first, so git diff shows only the rewrite.`,
    {
      code: "dirty_worktree",
      extensions: { files: dirty },
      next: [
        {
          when: "to see the changes first",
          command: `permdock ${input.invocation} --dry-run`,
        },
        {
          when: "to rewrite anyway",
          command: `permdock ${input.invocation} --force`,
        },
      ],
    },
  );
}
