import {
  existsSync,
  globSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import type { DoctorFinding } from './doctor-types.ts';
import type { PermDockConfig } from './types.ts';

import { rel } from './files.ts';
import { FIELD_VIEWS } from './rls-fields.ts';

export function pd005(cwd: string): readonly DoctorFinding[] {
  const lockPath = join(cwd, '.permdock/skills-lock.json');
  const folders = [
    join(cwd, '.agents/skills'),
    join(cwd, '.claude/skills'),
    join(cwd, '.cursor/skills'),
  ];
  const installed = folders.some((folder) =>
    existsSync(join(folder, 'wire-permdock/SKILL.md')),
  );
  if (!installed) {
    return [
      {
        code: 'PD005',
        severity: 'warning',
        message: 'Agent Skills are not installed',
        fix: 'pnpm exec permdock skills install',
      },
    ];
  }
  if (!existsSync(lockPath)) {
    return [
      {
        code: 'PD005',
        severity: 'warning',
        message: 'skills lock is missing',
        fix: 'pnpm exec permdock skills install',
      },
    ];
  }
  return [];
}

export function pd006(cwd: string): readonly DoctorFinding[] {
  try {
    const require = createRequire(resolve(cwd, 'package.json'));
    const pkg = require('typescript/package.json') as {
      readonly version: string;
    };
    const major = Number(pkg.version.split('.')[0]);
    if (major < 5 || (major === 5 && Number(pkg.version.split('.')[1]) < 9)) {
      return [
        {
          code: 'PD006',
          severity: 'error',
          message: `TypeScript ${pkg.version} is below the supported matrix (5.9, 6, 7)`,
          fix: 'upgrade typescript to 5.9 or later',
        },
      ];
    }
    if (major > 7) {
      return [
        {
          code: 'PD006',
          severity: 'error',
          message: `TypeScript ${pkg.version} is not in the supported matrix (5.9, 6, 7)`,
          fix: 'use TypeScript 5.9, 6 or 7',
        },
      ];
    }
    return [];
  } catch {
    return [
      {
        code: 'PD006',
        severity: 'error',
        message: 'typescript is not installed',
        fix: 'add typescript 5.9, 6 or 7',
      },
    ];
  }
}

export function pd009(cwd: string): readonly DoctorFinding[] {
  const copies: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > 6 || !existsSync(dir)) {
      return;
    }
    const pkg = join(dir, 'node_modules/permdock/package.json');
    if (existsSync(pkg)) {
      copies.push(pkg);
    }
    if (!existsSync(join(dir, 'node_modules'))) {
      return;
    }
    for (const name of readdirSync(join(dir, 'node_modules'))) {
      if (name.startsWith('.')) {
        continue;
      }
      const nested = join(dir, 'node_modules', name);
      try {
        if (statSync(nested).isDirectory()) {
          walk(nested, depth + 1);
        }
      } catch {
        // ignore broken links
      }
    }
  }
  walk(cwd, 0);
  if (copies.length > 1) {
    return [
      {
        code: 'PD009',
        severity: 'error',
        message: `duplicate permdock copies: ${copies.map((item) => rel(cwd, dirname(dirname(item)))).join(', ')}`,
        fix: 'dedupe so only one permdock version is installed',
      },
    ];
  }
  return [];
}

export function pd012(
  cwd: string,
  config: PermDockConfig,
): readonly DoctorFinding[] {
  const docs = config.openapi?.doc ?? [];
  const findings: DoctorFinding[] = [];
  for (const doc of docs) {
    const abs = resolve(cwd, doc);
    if (!existsSync(abs)) {
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    if (text.includes('"drafts"') && !text.includes('overlay')) {
      findings.push({
        code: 'PD012',
        severity: 'warning',
        message: `${doc} carries a draft pin the CLI no longer emits`,
        fix: 'regenerate with permdock openapi',
      });
    }
  }
  return findings;
}

export const MIGRATION_DIRS = [
  'supabase/migrations',
  'migrations',
  'drizzle',
  'prisma/migrations',
  'db/migrations',
] as const;

const VIEW_NAME = String.raw`((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)`;
const CREATE_VIEW = new RegExp(
  String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(?:recursive\s+)?view\s+${VIEW_NAME}([\s\S]*?)\bas\b`,
  'giu',
);
const ALTER_VIEW = new RegExp(
  String.raw`\balter\s+view\s+(?:if\s+exists\s+)?${VIEW_NAME}\s+set\s*\(([^)]*)\)`,
  'giu',
);
const INVOKER =
  /\bsecurity_invoker\s*(?:=\s*(?:true|on|'true'|'on'|1)\b|[,)]|$)/iu;
const COMPANION = new RegExp(
  String.raw`\bcomment\s+on\s+view\s+${VIEW_NAME}\s+is\s+'${FIELD_VIEWS.comment}\b`,
  'giu',
);

export function sqlFiles(cwd: string, entries: readonly string[]): string[] {
  const files = new Set<string>();
  for (const entry of entries) {
    const pattern = /[*?[{]/u.test(entry) ? entry : `${entry}/**/*.sql`;
    for (const match of globSync(pattern, { cwd })) {
      if (match.endsWith('.sql')) {
        files.add(resolve(cwd, match));
      }
    }
  }
  return [...files].toSorted();
}

function viewKey(name: string): string {
  const parts = name.split('.').map((part) => part.replaceAll('"', ''));
  return (parts.length === 1 ? ['public', ...parts] : parts)
    .join('.')
    .toLowerCase();
}

/**
 * Views run as their owner unless `security_invoker` is set, so they read
 * past RLS on the tables beneath them. The `<table>_visible_fields`
 * companion `rls generate --revoke-columns` writes reads as its owner on
 * purpose and carries a comment that says so.
 */
export function pd022(
  cwd: string,
  config: PermDockConfig,
): readonly DoctorFinding[] {
  if (config.rls === undefined && config.doctor?.migrations === undefined) {
    return [];
  }
  const created = new Map<string, string>();
  const invoker = new Set<string>();
  const companions = new Set<string>();
  for (const file of sqlFiles(
    cwd,
    config.doctor?.migrations ?? MIGRATION_DIRS,
  )) {
    const raw = readFileSync(file, 'utf8');
    const text = raw
      .replaceAll(/--[^\n]*/gu, '')
      .replaceAll(/\/\*[\s\S]*?\*\//gu, '');
    for (const [, name = '', options = ''] of text.matchAll(CREATE_VIEW)) {
      const key = viewKey(name);
      created.set(key, rel(cwd, file));
      if (INVOKER.test(options)) {
        invoker.add(key);
      } else {
        invoker.delete(key);
      }
    }
    for (const [, name = '', options = ''] of text.matchAll(ALTER_VIEW)) {
      if (INVOKER.test(options)) {
        invoker.add(viewKey(name));
      }
    }
    for (const [, name = ''] of raw.matchAll(COMPANION)) {
      companions.add(viewKey(name));
    }
  }
  return [...created]
    .filter(([key]) => !invoker.has(key) && !companions.has(key))
    .map(([key, file]) => ({
      code: 'PD022',
      severity: 'warning',
      message: `view ${key} in ${file} is not security_invoker, so it reads past row level security`,
      fix: `create the view with (security_invoker = true), or alter view ${key} set (security_invoker = true); Postgres 15 or later. For column-level reads, generate field views with permdock rls generate --fields views`,
    }));
}

const GRANT =
  /\b(grant|revoke)\s+([\s\S]+?)\s+on\s+(?:table\s+)?([\w."]+)\s+(?:to|from)\s+([\w\s,"]+?)(?:\s+with\s+grant\s+option|\s+cascade|\s+restrict)?\s*;/giu;
const CLIENT_ROLES = new Set(['anon', 'authenticated', 'public']);

function applyPrivilege(
  writable: Set<string>,
  verb: string,
  part: string,
): void {
  const match =
    /^\s*(all(?:\s+privileges)?|insert|update)\s*(?:\(([^)]*)\))?\s*$/iu.exec(
      part,
    );
  if (match === null) {
    return;
  }
  const columns =
    match[2] === undefined
      ? ['*']
      : match[2].split(',').map((column) => column.trim().replaceAll('"', ''));
  for (const column of columns) {
    if (verb.toLowerCase() === 'grant') {
      writable.add(column);
    } else if (column === '*') {
      writable.clear();
    } else {
      writable.delete(column);
    }
  }
}

/** Columns of `table` a client role may insert or update, per the migrations; `*` for every column. */
function clientWritable(
  cwd: string,
  config: PermDockConfig,
  target: string,
): Set<string> {
  const writable = new Set<string>();
  for (const file of sqlFiles(
    cwd,
    config.doctor?.migrations ?? MIGRATION_DIRS,
  )) {
    const text = readFileSync(file, 'utf8')
      .replaceAll(/--[^\n]*/gu, '')
      .replaceAll(/\/\*[\s\S]*?\*\//gu, '');
    for (const [
      ,
      verb = '',
      privileges = '',
      name = '',
      roles = '',
    ] of text.matchAll(GRANT)) {
      if (viewKey(name) !== target) {
        continue;
      }
      const clients = roles
        .split(',')
        .map((role) => role.trim().replaceAll('"', '').toLowerCase())
        .some((role) => CLIENT_ROLES.has(role));
      if (!clients) {
        continue;
      }
      for (const part of privileges.split(/,(?![^(]*\))/u)) {
        applyPrivilege(writable, verb, part);
      }
    }
  }
  return writable;
}

/** `attrs` claims must come from server-owned columns: never `user_metadata`, never a column clients can write. */
export function pd028(
  cwd: string,
  config: PermDockConfig,
  plan: (
    attrs: NonNullable<
      NonNullable<NonNullable<PermDockConfig['supabase']>['hook']>['attrs']
    >,
  ) => {
    readonly table?: string;
    readonly columns: readonly string[];
    readonly errors: readonly string[];
  },
): readonly DoctorFinding[] {
  const attrs = config.supabase?.hook?.attrs;
  if (attrs === undefined) {
    return [];
  }
  const planned = plan(attrs);
  const findings: DoctorFinding[] = planned.errors.map((message) => ({
    code: 'PD028',
    severity: 'error',
    message,
    fix: 'list server-owned columns or app_metadata.<key> entries; user_metadata is user-editable',
  }));
  if (planned.table !== undefined && planned.columns.length > 0) {
    const writable = clientWritable(cwd, config, viewKey(planned.table));
    const exposed = planned.columns.filter(
      (column) => writable.has('*') || writable.has(column),
    );
    if (exposed.length > 0) {
      findings.push({
        code: 'PD028',
        severity: 'warning',
        message: `attrs reads ${exposed.join(', ')} from ${viewKey(planned.table)}, which the migrations let anon or authenticated insert or update: a user could set their own attribute`,
        fix: `revoke insert, update on ${viewKey(planned.table)} from anon, authenticated, and grant column-level update only on columns that are not attributes; the generated hook migration refuses to install otherwise`,
      });
    }
  }
  return findings;
}
