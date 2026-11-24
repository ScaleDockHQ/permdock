import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type SupabaseConfigFormat = "toml" | "json" | "jsonc";

/** The file names the CLI looks for in `supabase/`, in its order of preference. */
type SupabaseConfigFile = {
  readonly file: string;
  readonly format: SupabaseConfigFormat;
};

const CONFIG_FILES: readonly SupabaseConfigFile[] = [
  { file: "supabase/config.json", format: "json" },
  { file: "supabase/config.jsonc", format: "jsonc" },
  { file: "supabase/config.toml", format: "toml" },
];

/**
 * The project's config file by the CLI's order of preference (`config.json`,
 * `config.jsonc`, `config.toml`), or `undefined` when it has none.
 */
export function supabaseConfigFile(
  cwd: string,
): SupabaseConfigFile | undefined {
  return CONFIG_FILES.find(({ file }) => existsSync(join(cwd, file)));
}

/**
 * The `supabase` directory relative to `cwd`: `supabase` when `cwd` has a
 * Supabase config or none is found, else the one in the nearest parent with
 * one, such as `../../supabase` for a config in `packages/identity`. The search
 * stops after the first directory with `.git`, so a checkout never reads a
 * project outside it.
 */
export function supabaseDir(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (supabaseConfigFile(dir) !== undefined) {
      return relative(cwd, join(dir, "supabase")).replaceAll("\\", "/");
    }
    const parent = dirname(dir);
    if (parent === dir || existsSync(join(dir, ".git"))) {
      return "supabase";
    }
    dir = parent;
  }
}
