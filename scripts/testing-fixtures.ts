import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `permdock/testing/fixtures` ships these example files byte for byte; `--check` fails when a copy drifts.
const FILES = [
  ["permissions.catalog.json", "better-supabase.catalog.json"],
  ["permdock.manifest.json", "better-supabase.manifest.json"],
] as const;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const example = join(root, "apps", "examples", "next-better-supabase");
const out = join(root, "packages", "permdock", "src", "testing", "fixtures");
const check = process.argv.includes("--check");

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const stale: string[] = [];
for (const [from, to] of FILES) {
  const source = readFileSync(join(example, from), "utf8");
  const target = join(out, to);
  if (readOrEmpty(target) === source) {
    continue;
  }
  if (check) {
    stale.push(to);
  } else {
    writeFileSync(target, source);
    process.stdout.write(`wrote ${target}\n`);
  }
}
if (stale.length > 0) {
  process.stderr.write(
    `packages/permdock/src/testing/fixtures is stale (${stale.join(", ")}); run pnpm --filter permdock gen\n`,
  );
  process.exitCode = 1;
}
