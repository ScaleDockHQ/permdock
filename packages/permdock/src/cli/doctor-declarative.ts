import { existsSync, globSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { DoctorFinding } from './doctor-types.ts';
import type { PermDockConfig } from './types.ts';

import { sqlFiles } from './doctor-project.ts';
import { rel } from './files.ts';
import { HOOK_MARKER } from './supabase-hook.ts';

const SCHEMAS = 'supabase/schemas';
const MIGRATIONS = 'supabase/migrations';

const CREATES_HOOK =
  /\bcreate\s+(?:or\s+replace\s+)?function\s+[\w."]*custom_access_token_hook\b/iu;
const DROPS_HOOK =
  /\bdrop\s+function\s+(?:if\s+exists\s+)?[\w."]*custom_access_token_hook\b/iu;
const GRANTS_HOOK =
  /\bgrant\s+execute\s+on\s+function\s+[\w."]*custom_access_token_hook\s*\(\s*jsonb\s*\)\s+to\s+supabase_auth_admin\b/iu;
const DEFINES_HELPER =
  /\bcreate\s+(?:or\s+replace\s+)?function\s+[\w."]*permdock_has\s*\(/iu;
const CALLS_HELPER =
  /\b(?:permdock_has|(?:permitted|member)_[a-z][a-z0-9_]*_ids)\s*\(/iu;

function uncommented(text: string): string {
  return text.replaceAll(/--[^\n]*/gu, '').replaceAll(/\/\*[\s\S]*?\*\//gu, '');
}

/**
 * PD042: a hook declared under `supabase/schemas` reaches the database through
 * `supabase db diff`, which drops its `supabase_auth_admin` grants. A function
 * created (or dropped and created again) without them is executable by
 * `public` and not by the auth server, so a migration at or after the one
 * that creates it must carry the grants.
 */
export function pd042(
  cwd: string,
  config: PermDockConfig,
): readonly DoctorFinding[] {
  if (config.supabase?.hook === undefined) {
    return [];
  }
  const declared = sqlFiles(cwd, [SCHEMAS]).some((file) =>
    readFileSync(file, 'utf8').startsWith(`${HOOK_MARKER} `),
  );
  if (!declared) {
    return [];
  }
  const migrations = sqlFiles(cwd, [MIGRATIONS]).map((file) => ({
    file,
    text: uncommented(readFileSync(file, 'utf8')),
  }));
  const created = migrations.findIndex(({ text }) => CREATES_HOOK.test(text));
  const dropped = migrations.findLastIndex(({ text }) => DROPS_HOOK.test(text));
  const needed = Math.max(created, dropped);
  if (needed === -1) {
    return [];
  }
  const granted = migrations.findLastIndex(({ text }) =>
    GRANTS_HOOK.test(text),
  );
  if (granted >= needed) {
    return [];
  }
  const at = rel(cwd, migrations[needed]?.file ?? MIGRATIONS);
  return [
    {
      code: 'PD042',
      severity: 'error',
      message: `${at} creates custom_access_token_hook from supabase/schemas, and no migration from it on grants it to supabase_auth_admin: supabase db diff drops those grants, so the auth server cannot call the hook and public can`,
      fix: 'generate the grants with permdock supabase hook generate --grants-out (or rls generate --split ...,hook --grants-out) into a new file from supabase migration new, after the db diff migration',
    },
  ];
}

/** The `[db.migrations] schema_paths` globs of `supabase/config.toml`, or Supabase's default. */
function schemaPaths(cwd: string): readonly string[] {
  const toml = join(cwd, 'supabase/config.toml');
  const fallback = ['./schemas/**/*.sql'];
  if (!existsSync(toml)) {
    return fallback;
  }
  const text = readFileSync(toml, 'utf8');
  const section = /^\[db\.migrations\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/mu.exec(
    text,
  )?.[1];
  const list = /^\s*schema_paths\s*=\s*\[([\s\S]*?)\]/mu.exec(
    section ?? '',
  )?.[1];
  if (list === undefined) {
    return fallback;
  }
  const paths = [...list.matchAll(/"([^"]*)"|'([^']*)'/gu)].map(
    ([, double, single]) => double ?? single ?? '',
  );
  return paths.length === 0 ? fallback : paths;
}

/** Schema files in the order `supabase db diff` applies them: each glob in turn, sorted within it. */
function orderedSchemaFiles(cwd: string): readonly string[] {
  const base = join(cwd, 'supabase');
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const pattern of schemaPaths(cwd)) {
    for (const match of globSync(pattern, { cwd: base }).toSorted()) {
      const path = resolve(base, match);
      if (path.endsWith('.sql') && !seen.has(path)) {
        seen.add(path);
        ordered.push(path);
      }
    }
  }
  return ordered;
}

/**
 * PD043: `db diff` applies schema files in `schema_paths` order, so a policy
 * that calls `permdock_has` or `permitted_<scope>_ids` before the file that
 * defines them fails to apply.
 */
export function pd043(cwd: string): readonly DoctorFinding[] {
  if (!existsSync(join(cwd, SCHEMAS))) {
    return [];
  }
  const files = orderedSchemaFiles(cwd).map((file) => ({
    file,
    text: uncommented(readFileSync(file, 'utf8')),
  }));
  const helpers = files.findIndex(({ text }) => DEFINES_HELPER.test(text));
  const defined = sqlFiles(cwd, [SCHEMAS]).find((file) =>
    DEFINES_HELPER.test(uncommented(readFileSync(file, 'utf8'))),
  );
  if (helpers === -1) {
    return defined === undefined
      ? []
      : [
          {
            code: 'PD043',
            severity: 'warning',
            message: `${rel(cwd, defined)} defines the PermDock helpers, but schema_paths in supabase/config.toml does not list it, so supabase db diff never applies it`,
            fix: `add it to [db.migrations] schema_paths before every file that calls permdock_has, permitted_<scope>_ids or member_<scope>_ids`,
          },
        ];
  }
  const helperFile = rel(cwd, files[helpers]?.file ?? '');
  return files
    .slice(0, helpers)
    .filter(({ text }) => CALLS_HELPER.test(text))
    .map(({ file }) => ({
      code: 'PD043',
      severity: 'warning',
      message: `${rel(cwd, file)} calls the PermDock helpers, but schema_paths applies it before ${helperFile}, which defines them`,
      fix: `list ${helperFile} earlier in [db.migrations] schema_paths, or give it a lower number, such as 056_permdock_helpers.sql before 060_policies.sql`,
    }));
}
