import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

function hasKey(file: string): boolean {
  if (!existsSync(file)) {
    return false;
  }
  const text = readFileSync(file, "utf8").trim();
  return text !== "" && text !== "[]";
}

/**
 * Auth reads `signing_keys_path` before `supabase start` and `config validate`.
 * The file is git-ignored. `gen signing-key --append` extends an array.
 */
export function ensureSigningKey(cwd = root): void {
  const file = path.join(cwd, "supabase/signing_keys.json");
  if (hasKey(file)) {
    return;
  }
  writeFileSync(file, "[]\n");
  const result = spawnSync(
    path.join(cwd, "node_modules/.bin/supabase"),
    ["gen", "signing-key", "--append"],
    { cwd, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error("supabase gen signing-key failed");
  }
}

if (import.meta.filename === path.resolve(process.argv[1])) {
  ensureSigningKey();
}
