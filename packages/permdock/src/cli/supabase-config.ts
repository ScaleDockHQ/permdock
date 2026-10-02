import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';

import type { DoctorFinding } from './doctor-types.ts';

/** The settings of `supabase/config.toml` doctor reads. */
export type SupabaseConfig = {
  /** `[auth] jwt_expiry`, in seconds. */
  readonly jwtExpiry?: number;
  /** `[db.migrations] schema_paths`, relative to `supabase/`. */
  readonly schemaPaths?: readonly string[];
};

export type SupabaseConfigRead =
  | { readonly ok: true; readonly config: SupabaseConfig }
  | { readonly ok: false; readonly error: string };

const SUPABASE_CONFIG = 'supabase/config.toml';

function table(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: a non-array object from the TOML parser is a TOML table.
  return value as Record<string, unknown>;
}

/** `supabase/config.toml`, parsed; `undefined` when the project has none. */
export function readSupabaseConfig(
  cwd: string,
): SupabaseConfigRead | undefined {
  const file = join(cwd, SUPABASE_CONFIG);
  if (!existsSync(file)) {
    return undefined;
  }
  let root: Readonly<Record<string, unknown>>;
  try {
    root = parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const expiry = table(root['auth'])?.['jwt_expiry'];
  const paths = table(table(root['db'])?.['migrations'])?.['schema_paths'];
  const schemaPaths = Array.isArray(paths)
    ? paths.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    ok: true,
    config: {
      ...(typeof expiry === 'number' ? { jwtExpiry: expiry } : {}),
      ...(schemaPaths === undefined ? {} : { schemaPaths }),
    },
  };
}

/** The parsed config, or `{}` when it is missing or does not parse (PD045 reports that). */
export function supabaseConfig(cwd: string): SupabaseConfig {
  const read = readSupabaseConfig(cwd);
  return read?.ok === true ? read.config : {};
}

/** PD045: a `supabase/config.toml` the CLI cannot parse, so every check that reads it falls back to defaults. */
export function pd045(cwd: string): readonly DoctorFinding[] {
  const read = readSupabaseConfig(cwd);
  if (read === undefined || read.ok) {
    return [];
  }
  return [
    {
      code: 'PD045',
      severity: 'warning',
      message: `${SUPABASE_CONFIG} does not parse: ${read.error.replace(/\n[\s\S]*/u, '')}`,
      fix: `fix the TOML syntax in ${SUPABASE_CONFIG}; until then doctor assumes Supabase's defaults for jwt_expiry and schema_paths`,
    },
  ];
}
