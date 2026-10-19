import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// The catalog installs `.better-supabase/better-supabase.tgz`, packed from the
// sibling checkout `../better-supabase`, else from a clone of COMMIT in
// `.better-supabase/source` (decision 0035). `pnpm pack` rewrites the
// sibling's own `catalog:` ranges, and an installed tarball resolves its peers
// from this repository; `link:` would resolve them from the sibling. The
// lockfile pins the tarball's integrity, so CI must pack the same commit.
const COMMIT = "b69e916e852707fd31078e971fd8c1124437e91a";
const REPOSITORY = "https://github.com/ScaleDockHQ/better-supabase.git";

const { values } = parseArgs({
  options: { force: { type: "boolean", default: false } },
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".better-supabase");
const sibling = join(root, "..", "better-supabase");
const checkout = existsSync(join(sibling, ".git"))
  ? sibling
  : join(out, "source");
const pkg = join(checkout, "packages", "better-supabase");
const tarball = join(out, "better-supabase.tgz");

function run(command: string, args: readonly string[], cwd = checkout): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

if (existsSync(tarball) && !values.force) {
  process.stdout.write(
    `better-supabase: ${tarball} exists; --force repacks it\n`,
  );
} else {
  if (!existsSync(join(checkout, ".git"))) {
    mkdirSync(checkout, { recursive: true });
    execFileSync("git", ["init", "--quiet", checkout], { stdio: "inherit" });
    run("git", ["remote", "add", "origin", REPOSITORY]);
    run("git", ["fetch", "--quiet", "--depth", "1", "origin", COMMIT]);
    run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  }
  const head = run("git", ["rev-parse", "HEAD"]).trim();
  if (head !== COMMIT) {
    process.stderr.write(
      `better-supabase: ${checkout} is at ${head}, not ${COMMIT}; CI packs ${COMMIT}\n`,
    );
  }
  if (!existsSync(join(pkg, "dist"))) {
    run("pnpm", [
      "install",
      "--frozen-lockfile",
      "--filter",
      "better-supabase...",
    ]);
    run("pnpm", ["exec", "turbo", "run", "build", "--filter=better-supabase"]);
  }
  const packs = join(out, "pack");
  rmSync(packs, { recursive: true, force: true });
  mkdirSync(packs, { recursive: true });
  run("pnpm", ["pack", "--pack-destination", packs], pkg);
  const packed = readdirSync(packs).find((file) => file.endsWith(".tgz"));
  if (packed === undefined) {
    throw new Error(`better-supabase: pnpm pack wrote no tarball to ${packs}`);
  }
  renameSync(join(packs, packed), tarball);
  rmSync(packs, { recursive: true, force: true });
  process.stdout.write(`better-supabase: packed ${head} to ${tarball}\n`);
}
