import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { argv, exit } from "node:process";

/**
 * Lints the staged files with the oxlint call of the workspace that owns each
 * one, so a commit never waits on, or fails because of, files it does not
 * touch. Root files take the `lint:root` call. `lefthook.yml` runs it on
 * pre-commit; the affected gate runs on pre-push.
 */

const ROOT = resolve(import.meta.dirname, "..");
const OXLINT = join(ROOT, "node_modules/.bin/oxlint");
const LINTABLE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
const ROOT_FILES = new Set([
  "commitlint.config.ts",
  "knip.mts",
  "oxfmt.config.ts",
  "oxlint.config.ts",
  "vitest.config.ts",
]);

function hasOxlintScript(dir: string): boolean {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return false;
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return false;
  const scripts: unknown = Object.getOwnPropertyDescriptor(
    parsed,
    "scripts",
  )?.value;
  if (typeof scripts !== "object" || scripts === null) return false;
  const lint: unknown = Object.getOwnPropertyDescriptor(scripts, "lint")?.value;
  return typeof lint === "string" && lint.includes("oxlint");
}

/** The workspace folder that lints `file`, or `ROOT` when the root call does. */
function owner(file: string): string | undefined {
  if (ROOT_FILES.has(file) || file.startsWith("scripts/")) return ROOT;
  let dir = dirname(join(ROOT, file));
  while (dir !== ROOT && dir.startsWith(ROOT)) {
    if (hasOxlintScript(dir)) return dir;
    dir = dirname(dir);
  }
  return undefined;
}

const groups = new Map<string, string[]>();
for (const file of argv.slice(2).filter((f) => LINTABLE.test(f))) {
  const dir = owner(file);
  if (dir === undefined) continue;
  groups.set(dir, [...(groups.get(dir) ?? []), join(ROOT, file)]);
}

let failed = false;
for (const [dir, files] of groups) {
  const flags = dir === ROOT ? [] : ["--disable-nested-config", "--type-aware"];
  const run = spawnSync(
    OXLINT,
    [...flags, ...files.map((f) => relative(dir, f))],
    { cwd: dir, stdio: "inherit" },
  );
  if (run.status !== 0) failed = true;
}
exit(failed ? 1 : 0);
