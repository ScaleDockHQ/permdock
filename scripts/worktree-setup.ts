import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv, env, stdout } from "node:process";

/**
 * Prepares a linked git worktree: copies the ignored `.env*` files from the
 * main worktree without database keys, installs from the pnpm store, and starts
 * the example's Supabase stack only with `--db`. `.cursor/worktrees.json` runs
 * it; run it by hand after `git worktree add`.
 */

// A copied key must never point a new worktree at the main worktree's database.
const DATABASE_KEY =
  /^(?:DATABASE_URL|DIRECT_URL|DB_URL|PG[A-Z_]*|POSTGRES[A-Z_]*|(?:NEXT_PUBLIC_)?SUPABASE_[A-Z_]*|[A-Z_]+_(?:DATABASE|DB)_URL)$/u;

const git = (cwd: string, ...args: readonly string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const root = git(process.cwd(), "rev-parse", "--show-toplevel");
const main =
  env["ROOT_WORKTREE_PATH"] ??
  dirname(resolve(root, git(root, "rev-parse", "--git-common-dir")));

function keyOf(line: string): string | null {
  const match = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/u.exec(line);
  return match?.[1] ?? null;
}

function copyEnvFiles(): void {
  const files = git(
    main,
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    ":(glob)**/.env*",
    ":(glob,exclude)**/node_modules/**",
  )
    .split("\n")
    .filter((file) => file !== "" && !file.endsWith(".env.example"));
  for (const file of files) {
    const target = join(root, file);
    if (existsSync(target)) {
      stdout.write(`keep   ${file}\n`);
      continue;
    }
    const stripped: string[] = [];
    const lines = readFileSync(join(main, file), "utf8")
      .split("\n")
      .filter((line) => {
        const key = keyOf(line);
        if (key !== null && DATABASE_KEY.test(key)) {
          stripped.push(key);
          return false;
        }
        return true;
      });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, lines.join("\n"), { mode: 0o600 });
    const note =
      stripped.length === 0 ? "" : ` (dropped ${stripped.join(", ")})`;
    stdout.write(`copy   ${file}${note}\n`);
  }
}

if (resolve(main) === resolve(root)) {
  stdout.write("main worktree: no env files to copy\n");
} else {
  copyEnvFiles();
}

// `--offline` fails once the lockfile names a tarball the store lacks;
// `--prefer-offline` fetches only those.
execFileSync("pnpm", ["install", "--prefer-offline", "--frozen-lockfile"], {
  cwd: root,
  stdio: "inherit",
});

if (argv.includes("--db")) {
  execFileSync(
    "pnpm",
    ["--filter", "@permdock/example-next-better-supabase", "supabase:start"],
    { cwd: root, stdio: "inherit" },
  );
}
