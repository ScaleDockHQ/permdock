import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { SupabaseHookManifest } from '../supabase/manifest.ts';
import type { DoctorFinding } from './doctor-types.ts';
import type { PermDockConfig } from './types.ts';

import { readMemberships } from '../supabase/subject.ts';
import { MIGRATION_DIRS, sqlFiles } from './doctor-project.ts';
import { requirePeer } from './peer.ts';

const HELPER_NAME = /^(?:permdock_has|permitted_[a-z][a-z0-9_]*_ids)$/u;

function escape(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/** The helper functions `sql` creates in `schema`; unqualified names count for `public`. */
export function helpersDefined(
  sql: string,
  schema: string,
): ReadonlySet<string> {
  const qualifier =
    schema === 'public'
      ? String.raw`(?:(?:"public"|public)\.)?`
      : String.raw`(?:"${escape(schema)}"|${escape(schema)})\.`;
  const create = new RegExp(
    String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+${qualifier}"?([a-z_][a-z0-9_]*)"?\s*\(`,
    'giu',
  );
  const names = new Set<string>();
  for (const match of sql.matchAll(create)) {
    const name = (match[1] ?? '').toLowerCase();
    if (HELPER_NAME.test(name)) {
      names.add(name);
    }
  }
  return names;
}

/** SQL files that may hold the generated helpers: `rls.out` (else `rls.sql`) and the migration folders, not the hook itself. */
function helperSources(
  cwd: string,
  config: PermDockConfig,
  hookOut: string,
): readonly string[] {
  const hook = resolve(cwd, hookOut);
  const files = new Set(
    sqlFiles(cwd, config.doctor?.migrations ?? MIGRATION_DIRS),
  );
  const rlsOut = resolve(cwd, config.rls?.out ?? 'rls.sql');
  if (rlsOut.endsWith('.sql') && existsSync(rlsOut)) {
    files.add(rlsOut);
  }
  files.delete(hook);
  return [...files];
}

export function missingHelpersInFiles(
  cwd: string,
  config: PermDockConfig,
  manifest: SupabaseHookManifest,
): readonly string[] {
  const found = new Set<string>();
  for (const file of helperSources(cwd, config, manifest.hook.out)) {
    for (const name of helpersDefined(
      readFileSync(file, 'utf8'),
      manifest.helpers.schema,
    )) {
      found.add(name);
    }
  }
  return manifest.helpers.functions.filter((name) => !found.has(name));
}

export async function missingHelpersInDb(
  db: string,
  manifest: SupabaseHookManifest,
): Promise<readonly string[]> {
  const pg = await requirePeer(
    () => import('pg'),
    'pg',
    'permdock supabase hook generate --db',
  );
  const client = new pg.Client({ connectionString: db });
  try {
    await client.connect();
  } catch (cause) {
    throw new Error(
      'PermDock CLI: supabase hook generate --db could not connect',
      {
        cause,
      },
    );
  }
  try {
    const result = await client.query<{ readonly proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = $1 and p.proname = any($2::text[])`,
      [manifest.helpers.schema, [...manifest.helpers.functions]],
    );
    const found = new Set(result.rows.map((row) => row.proname));
    return manifest.helpers.functions.filter((name) => !found.has(name));
  } finally {
    await client.end();
  }
}

export function missingHelpersMessage(
  manifest: SupabaseHookManifest,
  missing: readonly string[],
): string {
  return `PD039 schema ${manifest.helpers.schema} has no ${missing.join(', ')}: the hook's claims are read by these helpers; run permdock rls generate and apply its migration`;
}

/** Bytes of JSON of each extra claim in the largest sample, for claims that pass the budget. */
export function oversizedClaims(
  samples: readonly unknown[],
  manifest: SupabaseHookManifest,
): readonly { readonly name: string; readonly bytes: number }[] {
  const encoder = new TextEncoder();
  const oversized: { name: string; bytes: number }[] = [];
  for (const claim of manifest.claims) {
    if (claim.source === 'permdock') {
      continue;
    }
    let bytes = 0;
    for (const sample of samples) {
      if (sample === null || typeof sample !== 'object') {
        continue;
      }
      const value: unknown = Object.hasOwn(sample, claim.name)
        ? (sample as Readonly<Record<string, unknown>>)[claim.name]
        : undefined;
      if (value !== undefined) {
        bytes = Math.max(
          bytes,
          encoder.encode(JSON.stringify(value)).byteLength,
        );
      }
    }
    if (bytes > manifest.budget.bytes) {
      oversized.push({ name: claim.name, bytes });
    }
  }
  return oversized;
}

/** `memberships[i]` entries `subjectFromSupabase` drops, per sample index. */
export function droppedMemberships(
  samples: readonly unknown[],
): readonly { readonly sample: number; readonly entries: readonly number[] }[] {
  const out: { sample: number; entries: readonly number[] }[] = [];
  for (const [index, sample] of samples.entries()) {
    if (sample === null || typeof sample !== 'object') {
      continue;
    }
    const claim: unknown = Object.hasOwn(sample, 'memberships')
      ? (sample as Readonly<Record<string, unknown>>).memberships
      : undefined;
    const { dropped } = readMemberships(claim);
    if (dropped.length > 0) {
      out.push({ sample: index, entries: dropped });
    }
  }
  return out;
}

export function pd039(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly manifest: SupabaseHookManifest;
}): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const missing = missingHelpersInFiles(
    input.cwd,
    input.config,
    input.manifest,
  );
  if (missing.length > 0) {
    findings.push({
      code: 'PD039',
      severity: 'warning',
      message: missingHelpersMessage(input.manifest, missing).slice(
        'PD039 '.length,
      ),
      fix: 'run permdock rls generate, or set rls.out to the migration that holds the helpers',
    });
  }
  const fixture = input.config.doctor?.claims;
  if (fixture !== undefined) {
    const parsed: unknown = JSON.parse(
      readFileSync(resolve(input.cwd, fixture), 'utf8'),
    );
    const samples = Array.isArray(parsed) ? parsed : [];
    for (const claim of oversizedClaims(samples, input.manifest)) {
      findings.push({
        code: 'PD039',
        severity: 'warning',
        message: `claim ${claim.name} is ${String(claim.bytes)} bytes of JSON in ${fixture}, more than the ${String(input.manifest.budget.bytes)}-byte memberships budget`,
        fix: 'return less from the claim function, or read the data per request instead of from the token',
      });
    }
    for (const { sample, entries } of droppedMemberships(samples)) {
      findings.push({
        code: 'PD039',
        severity: 'warning',
        message: `sample ${String(sample)} in ${fixture} has memberships ${entries.map((entry) => `[${String(entry)}]`).join(', ')} that subjectFromSupabase drops (membership-dropped)`,
        fix: 'emit { scope, id, roles } (or tenant, team or on) with a non-empty roles array for each entry',
      });
    }
  }
  return findings;
}
