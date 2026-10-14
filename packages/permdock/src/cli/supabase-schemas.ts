import type { PermDockConfig, SupabaseSchemas } from "./types.ts";

import { declarativeSchemaDir, supabaseConfig } from "./supabase-config.ts";

const MODES = [
  "pg-delta",
  "migra",
  "migrations",
] as const satisfies readonly SupabaseSchemas[];

/** The schema workflow PermDock generates for, after the flag, the config and `config.toml`. */
export type ResolvedSchemas =
  | {
      readonly mode: "pg-delta";
      /** The declarative schema directory, relative to the working directory. */
      readonly schemaDir: string;
    }
  | { readonly mode: "migra" }
  | { readonly mode: "migrations" };

export function isSupabaseSchemas(value: unknown): value is SupabaseSchemas {
  return MODES.some((mode) => mode === value);
}

/** The `--schemas` refusal, or `undefined` when the value is one of the modes. */
export function schemasRefusal(
  command: string,
  value: string | undefined,
): string | undefined {
  return value === undefined || isSupabaseSchemas(value)
    ? undefined
    : `${command} --schemas must be ${MODES.join(", ")} (got ${value})`;
}

/**
 * `--schemas`, else `supabase.schemas`, else `migra` when `config.toml`
 * sets `[experimental.pgdelta] enabled = false`, else `pg-delta`: the default
 * of new Supabase projects and of the next Supabase CLI major.
 */
export function resolveSchemas(
  cwd: string,
  config: PermDockConfig,
  flag?: SupabaseSchemas,
): ResolvedSchemas {
  const toml = supabaseConfig(cwd).pgDelta;
  const mode =
    flag ??
    config.supabase?.schemas ??
    (toml?.enabled === false ? "migra" : "pg-delta");
  switch (mode) {
    case "pg-delta":
      return {
        mode,
        schemaDir: toml?.schemaDir ?? declarativeSchemaDir(),
      };
    case "migra":
    case "migrations":
      return { mode };
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}
