import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { argv, stdout } from "node:process";

/**
 * Lists the local Supabase stacks this repository's worktrees left behind: a
 * stack whose folder is gone, or whose branch no longer exists. Prints them by
 * default; `--apply` destroys them with their data. Stacks of other
 * repositories on the machine are never touched.
 */

type Stack = {
  readonly id: string;
  readonly projectRoot: string;
  readonly branch: string;
  readonly runtime: string;
};

const git = (...args: readonly string[]): string =>
  execFileSync("git", args, { encoding: "utf8" }).trim();

const root = git("rev-parse", "--show-toplevel");
const main = dirname(resolve(root, git("rev-parse", "--git-common-dir")));
// The CLI offers `stack` only when run beside a `supabase/` project.
const example = join(root, "apps/examples/next-better-supabase");
const supabase = join(example, "node_modules/.bin/supabase");

function field(value: object, key: string): string {
  const entry: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof entry === "string" ? entry : "";
}

function stacks(): Stack[] {
  const parsed: unknown = JSON.parse(
    execFileSync(supabase, ["stack", "list", "--output-format", "json"], {
      cwd: example,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  const list: unknown =
    typeof parsed === "object" && parsed !== null && "stacks" in parsed
      ? parsed.stacks
      : [];
  if (!Array.isArray(list)) {
    return [];
  }
  return list.flatMap((item: unknown) =>
    typeof item === "object" && item !== null
      ? [
          {
            id: field(item, "id"),
            projectRoot: field(item, "project_root"),
            branch: field(item, "branch_context"),
            runtime: field(item, "runtime"),
          },
        ]
      : [],
  );
}

// Worktrees sit beside the main checkout and share its name as a prefix.
const family = join(dirname(main), basename(main));
const ours = (stack: Stack): boolean =>
  stack.projectRoot === main ||
  stack.projectRoot.startsWith(`${main}/`) ||
  stack.projectRoot.startsWith(`${family}-`);

function branchExists(ref: string): boolean {
  try {
    git("show-ref", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

function orphanReason(stack: Stack): string | null {
  if (!existsSync(stack.projectRoot)) {
    return "folder removed";
  }
  if (stack.branch.startsWith("refs/heads/") && !branchExists(stack.branch)) {
    return "branch deleted";
  }
  return null;
}

const apply = argv.includes("--apply");
const orphans = stacks()
  .filter(ours)
  .flatMap((stack) => {
    const reason = orphanReason(stack);
    return reason === null ? [] : [{ stack, reason }];
  });

if (orphans.length === 0) {
  stdout.write("No orphaned Supabase stacks.\n");
}
for (const { stack, reason } of orphans) {
  const label = `${stack.id.slice(0, 12)} ${stack.runtime} ${stack.branch} ${stack.projectRoot} (${reason})`;
  if (!apply) {
    stdout.write(`would destroy ${label}\n`);
    continue;
  }
  execFileSync(
    supabase,
    ["stack", "destroy", "--stack-id", stack.id, "--yes"],
    { cwd: example, stdio: "inherit" },
  );
  stdout.write(`destroyed ${label}\n`);
}
if (!apply && orphans.length > 0) {
  stdout.write("Run with --apply to destroy them and their data.\n");
}
