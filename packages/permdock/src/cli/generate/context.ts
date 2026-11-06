import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import type { SupabaseConfig } from "../supabase-config.ts";

import { packageManagerOf } from "../core/peer.ts";
import { readSupabaseConfig } from "../supabase-config.ts";

/**
 * What a generate run reads from disk once: `config.toml`, the schema
 * directory, the migrations index and the package manager.
 */
export type ProjectContext = {
  readonly cwd: string;
  readonly supabase: SupabaseConfig | undefined;
  readonly supabaseError: string | undefined;
  /** `supabase/schemas`, or the pg-delta path when `config.toml` sets one. */
  readonly schemaDir: string | undefined;
  readonly schemaFiles: readonly string[];
  readonly migrations: readonly string[];
  readonly packageManager: string | undefined;
};

function filesUnder(cwd: string, dir: string): readonly string[] {
  const abs = join(cwd, dir);
  if (!existsSync(abs)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of readdirSync(abs, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) {
      continue;
    }
    found.push(relative(cwd, join(entry.parentPath, entry.name)));
  }
  return found.toSorted();
}

/** Parses `supabase/config.toml` once and lists the schema and migration files. */
export async function projectContext(cwd: string): Promise<ProjectContext> {
  const read = readSupabaseConfig(cwd);
  const supabase = read?.ok === true ? read.config : undefined;
  const schemaDir =
    supabase?.pgDelta?.schemaDir ??
    (existsSync(join(cwd, "supabase/schemas"))
      ? "supabase/schemas"
      : undefined);
  const manager = await packageManagerOf(cwd);
  return {
    cwd,
    supabase,
    supabaseError: read?.ok === false ? read.error : undefined,
    schemaDir,
    schemaFiles: schemaDir === undefined ? [] : filesUnder(cwd, schemaDir),
    migrations: filesUnder(cwd, "supabase/migrations"),
    packageManager: manager,
  };
}
