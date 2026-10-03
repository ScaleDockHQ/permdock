import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DoctorFinding } from './doctor-types.ts';
import type { PermDockConfig } from './types.ts';

import { PERMDOCK_SCHEMA } from '../supabase/sources.ts';
import { tableKey } from './deciding-columns.ts';
import { MIGRATION_DIRS } from './doctor-project.ts';
import { rel, sqlFiles } from './files.ts';
import { sqlStatements } from './sql-statements.ts';
import { supabaseConfig } from './supabase-config.ts';

/** One statement of a migration: comments blanked, its file and first line. */
type SqlStatement = {
  readonly file: string;
  readonly line: number;
  readonly text: string;
};

/** Supabase's `[api] schemas` when `config.toml` sets none. */
const API_SCHEMAS = ['public', 'graphql_public'] as const;

const NAME = String.raw`((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)`;
const IDENT = String.raw`("[^"]+"|\w+)`;

/** A statement without its dollar-quoted bodies: what a function header says. */
function header(text: string): string {
  return text.replaceAll(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/gu, '$$$$');
}

function isSupabase(cwd: string, config: PermDockConfig): boolean {
  return (
    existsSync(join(cwd, 'supabase')) ||
    config.rls?.dialect === 'supabase' ||
    config.supabase !== undefined
  );
}

function migrationStatements(
  cwd: string,
  config: PermDockConfig,
): readonly SqlStatement[] {
  return sqlFiles(cwd, config.doctor?.migrations ?? MIGRATION_DIRS).flatMap(
    (file) =>
      sqlStatements(readFileSync(file, 'utf8')).map((statement) =>
        Object.assign({ file: rel(cwd, file) }, statement),
      ),
  );
}

function schemaOf(key: string): string {
  return key.split('.')[0] ?? 'public';
}

function unquote(name: string): string {
  return name.replaceAll('"', '').toLowerCase();
}

/**
 * PD046: the schema of PermDock's `security definer` helpers is one the Data
 * API exposes, so PostgREST serves them as RPCs.
 */
export function pd046(
  cwd: string,
  config: PermDockConfig,
): readonly DoctorFinding[] {
  if (!existsSync(join(cwd, 'supabase/config.toml'))) {
    return [];
  }
  const schema =
    config.rls?.schema ?? config.rls?.rbac?.schema ?? PERMDOCK_SCHEMA;
  const exposed = supabaseConfig(cwd).apiSchemas ?? API_SCHEMAS;
  if (!exposed.includes(schema)) {
    return [];
  }
  return [
    {
      code: 'PD046',
      severity: 'warning',
      message: `the PermDock helper schema ${schema} is in [api] schemas in supabase/config.toml, so the Data API serves its security definer helpers as RPCs`,
      fix:
        schema === 'public'
          ? `drop rls.schema: 'public' so the helpers move to the private ${PERMDOCK_SCHEMA} schema, regenerate with permdock rls generate, and keep ${PERMDOCK_SCHEMA} out of [api] schemas`
          : `remove ${schema} from [api] schemas; policies reach the helpers through grant usage, not the Data API`,
    },
  ];
}

const USER_METADATA = /\b(raw_user_meta_data|user_metadata)\b/giu;

/** PD047: SQL that reads `user_metadata`, which every user can edit for themselves. */
export function pd047(
  cwd: string,
  config: PermDockConfig,
): readonly DoctorFinding[] {
  if (!isSupabase(cwd, config)) {
    return [];
  }
  return migrationStatements(cwd, config).flatMap((statement) =>
    [...statement.text.matchAll(USER_METADATA)].map((match) => ({
      code: 'PD047',
      severity: 'warning' as const,
      message: `${statement.file}:${String(statement.line + statement.text.slice(0, match.index).split('\n').length - 1)} reads ${match[1] ?? 'user_metadata'}, which a user can set for themselves`,
      fix: 'decide access from app_metadata (raw_app_meta_data), a server-owned table or a hook claim; user_metadata is for display only',
    })),
  );
}

const CREATE_FUNCTION = new RegExp(
  String.raw`^create\s+(?:or\s+replace\s+)?function\s+${NAME}\s*\(`,
  'iu',
);
const ALTER_SEARCH_PATH = new RegExp(
  String.raw`^alter\s+function\s+${NAME}\s*(?:\([^)]*\))?\s+set\s+search_path\b`,
  'iu',
);
const REVOKE_EXECUTE = new RegExp(
  String.raw`^revoke\s+(?:all(?:\s+privileges)?|execute)\s+on\s+(?:function|routine)\s+${NAME}\s*(?:\([^)]*\))?\s+from\s+([\s\S]+)$`,
  'iu',
);
const REVOKE_ALL_FUNCTIONS = new RegExp(
  String.raw`^(?:alter\s+default\s+privileges\s+(?:for\s+role\s+\S+\s+)?in\s+schema\s+${IDENT}\s+)?revoke\s+(?:all(?:\s+privileges)?|execute)\s+on\s+(?:all\s+)?(?:functions|routines)(?:\s+in\s+schema\s+${IDENT})?\s+from\s+([\s\S]+)$`,
  'iu',
);

type CreatedFunction = SqlStatement & {
  readonly key: string;
  readonly head: string;
};

function createdFunctions(
  statements: readonly SqlStatement[],
): readonly CreatedFunction[] {
  return statements.flatMap((statement) => {
    const match = CREATE_FUNCTION.exec(statement.text);
    return match === null
      ? []
      : [
          {
            ...statement,
            key: tableKey(match[1] ?? ''),
            head: header(statement.text),
          },
        ];
  });
}

/** PD048: a function without `set search_path`, so a caller's objects can shadow the ones it names. */
export function pd048(
  cwd: string,
  config: PermDockConfig,
): readonly DoctorFinding[] {
  if (!isSupabase(cwd, config)) {
    return [];
  }
  const statements = migrationStatements(cwd, config);
  const altered = new Set(
    statements.flatMap((statement) => {
      const match = ALTER_SEARCH_PATH.exec(statement.text);
      return match === null ? [] : [tableKey(match[1] ?? '')];
    }),
  );
  return createdFunctions(statements)
    .filter(
      (fn) =>
        !/\bset\s+search_path\b/iu.test(fn.head) &&
        !altered.has(fn.key) &&
        !/\blanguage\s+(?:c|internal)\b/iu.test(fn.head),
    )
    .map((fn) => {
      const definer = /\bsecurity\s+definer\b/iu.test(fn.head);
      return {
        code: 'PD048',
        severity: 'warning' as const,
        message: `${fn.file}:${String(fn.line)} ${definer ? 'security definer ' : ''}function ${fn.key} sets no search_path${definer ? ', so a caller can shadow what it reads with their own objects' : ''}`,
        fix: `add set search_path = '' and qualify every name in the body (Supabase advisor function_search_path_mutable)`,
      };
    });
}

/** Roles each `revoke` statement takes `execute` from, per function key or `schema.*`. */
function revokedExecute(
  statements: readonly SqlStatement[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const revoked = new Map<string, Set<string>>();
  const add = (key: string, roles: string): void => {
    const set = revoked.get(key) ?? new Set<string>();
    for (const role of roles.split(',')) {
      set.add(unquote(role.trim().replace(/\s+(?:cascade|restrict)$/iu, '')));
    }
    revoked.set(key, set);
  };
  for (const statement of statements) {
    const one = REVOKE_EXECUTE.exec(statement.text);
    if (one !== null) {
      add(tableKey(one[1] ?? ''), one[2] ?? '');
      continue;
    }
    const all = REVOKE_ALL_FUNCTIONS.exec(statement.text);
    if (all !== null) {
      const schema = all[1] ?? all[2];
      add(`${schema === undefined ? '*' : unquote(schema)}.*`, all[3] ?? '');
    }
  }
  return revoked;
}

/**
 * PD049: a `security definer` function `public` (every role) or, in Supabase's
 * `public` schema, `anon` may still execute: Postgres grants `execute` to
 * `public` on create, and Supabase's default privileges grant it to `anon`.
 */
export function pd049(
  cwd: string,
  config: PermDockConfig,
): readonly DoctorFinding[] {
  if (!isSupabase(cwd, config)) {
    return [];
  }
  const statements = migrationStatements(cwd, config);
  const revoked = revokedExecute(statements);
  const findings: DoctorFinding[] = [];
  for (const fn of createdFunctions(statements)) {
    if (
      !/\bsecurity\s+definer\b/iu.test(fn.head) ||
      /\breturns\s+(?:event_)?trigger\b/iu.test(fn.head)
    ) {
      continue;
    }
    const schema = schemaOf(fn.key);
    const from = new Set([
      ...(revoked.get(fn.key) ?? []),
      ...(revoked.get(`${schema}.*`) ?? []),
      ...(revoked.get('*.*') ?? []),
    ]);
    const missing = ['public', ...(schema === 'public' ? ['anon'] : [])].filter(
      (role) => !from.has(role),
    );
    if (missing.length > 0) {
      findings.push({
        code: 'PD049',
        severity: 'warning',
        message: `${fn.file}:${String(fn.line)} security definer function ${fn.key} can be executed by ${missing.join(' and ')}`,
        fix: `revoke execute on function ${fn.key}(…) from public, anon; then grant execute to the roles that call it`,
      });
    }
  }
  return findings;
}

const CREATE_TABLE = new RegExp(
  String.raw`^create\s+(?:(?:global|local)\s+)?(?:(?:temp|temporary|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?${NAME}\s*\(`,
  'iu',
);
const ENABLE_RLS = new RegExp(
  String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}[\s\S]*\benable\s+row\s+level\s+security\b`,
  'iu',
);
const DROP_TABLE =
  /^drop\s+table\s+(?:if\s+exists\s+)?([\s\S]+?)(?:\s+(?:cascade|restrict))?$/iu;

/** PD050: a `public` table without row level security, which the Data API serves whole. */
export function pd050(
  cwd: string,
  config: PermDockConfig,
): readonly DoctorFinding[] {
  if (!isSupabase(cwd, config)) {
    return [];
  }
  const created = new Map<string, SqlStatement>();
  const enabled = new Set<string>();
  for (const statement of migrationStatements(cwd, config)) {
    const table = CREATE_TABLE.exec(statement.text);
    if (table !== null) {
      created.set(tableKey(table[1] ?? ''), statement);
      continue;
    }
    const rls = ENABLE_RLS.exec(statement.text);
    if (rls !== null) {
      enabled.add(tableKey(rls[1] ?? ''));
      continue;
    }
    const dropped = DROP_TABLE.exec(statement.text);
    if (dropped !== null) {
      for (const name of (dropped[1] ?? '').split(',')) {
        created.delete(tableKey(name.trim()));
      }
    }
  }
  return [...created]
    .filter(([key]) => schemaOf(key) === 'public' && !enabled.has(key))
    .map(([key, statement]) => ({
      code: 'PD050',
      severity: 'error',
      message: `${statement.file}:${String(statement.line)} creates ${key} without row level security, so the Data API serves every row to anon and authenticated`,
      fix: `alter table ${key} enable row level security; permdock rls generate writes its policies`,
    }));
}

const CREATE_POLICY = new RegExp(
  String.raw`^create\s+policy\s+${IDENT}\s+on\s+${NAME}([\s\S]*)$`,
  'iu',
);
const UNWRAPPED_AUTH = /(?<!\bselect\s{1,20})\bauth\.(uid|jwt)\s*\(\s*\)/giu;

/** PD051: a policy that calls `auth.uid()` or `auth.jwt()` bare, so Postgres runs it once per row. */
export function pd051(
  cwd: string,
  config: PermDockConfig,
): readonly DoctorFinding[] {
  if (!isSupabase(cwd, config)) {
    return [];
  }
  return migrationStatements(cwd, config).flatMap((statement) => {
    const policy = CREATE_POLICY.exec(statement.text);
    if (policy === null) {
      return [];
    }
    const calls = [
      ...new Set(
        [...(policy[3] ?? '').matchAll(UNWRAPPED_AUTH)].map(
          (match) => `auth.${(match[1] ?? '').toLowerCase()}()`,
        ),
      ),
    ];
    return calls.length === 0
      ? []
      : [
          {
            code: 'PD051',
            severity: 'warning' as const,
            message: `${statement.file}:${String(statement.line)} policy ${unquote(policy[1] ?? '')} on ${tableKey(policy[2] ?? '')} calls ${calls.join(' and ')} once per row`,
            fix: `wrap each call as (select ${calls[0] ?? 'auth.uid()'}) so Postgres evaluates it once per statement (Supabase advisor auth_rls_initplan)`,
          },
        ];
  });
}

/** PD052: an update policy without `with check`, so nothing states what a row may become. */
export function pd052(
  cwd: string,
  config: PermDockConfig,
): readonly DoctorFinding[] {
  if (!isSupabase(cwd, config)) {
    return [];
  }
  return migrationStatements(cwd, config).flatMap((statement) => {
    const policy = CREATE_POLICY.exec(statement.text);
    const rest = policy?.[3] ?? '';
    if (
      policy === null ||
      !/\bfor\s+update\b/iu.test(rest) ||
      /\bwith\s+check\b/iu.test(rest)
    ) {
      return [];
    }
    return [
      {
        code: 'PD052',
        severity: 'warning' as const,
        message: `${statement.file}:${String(statement.line)} update policy ${unquote(policy[1] ?? '')} on ${tableKey(policy[2] ?? '')} has no with check, so Postgres checks the new row against using alone`,
        fix: 'add with check (...) stating what the updated row must satisfy, such as the same tenant and owner test, so an update cannot move a row out of what the user may write',
      },
    ];
  });
}

/** Top-level comma-separated parts of a parenthesised list. */
function topLevelParts(body: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(body.slice(start).trim());
  return parts.filter((part) => part !== '');
}

/**
 * One column definition or table constraint of a `create table` body: its
 * first column, whether it is a foreign key, and whether a primary key or
 * unique constraint indexes that column.
 */
function tablePart(raw: string): {
  readonly column: string;
  readonly foreign: boolean;
  readonly indexed: boolean;
} {
  const part = raw.replace(/^constraint\s+(?:"[^"]+"|\w+)\s+/iu, '');
  const listed = /^(foreign\s+key|primary\s+key|unique)\s*\(([^)]*)\)/iu.exec(
    part,
  );
  if (listed !== null) {
    const foreign = /^foreign/iu.test(listed[1] ?? '');
    return {
      column: firstColumn(listed[2] ?? ''),
      foreign,
      indexed: !foreign,
    };
  }
  return {
    column: unquote(/^("[^"]+"|\w+)/u.exec(part)?.[1] ?? ''),
    foreign: /\breferences\b/iu.test(part),
    indexed: /\b(?:primary\s+key|unique)\b/iu.test(part),
  };
}

function firstColumn(list: string): string {
  return unquote(list.split(',')[0]?.trim() ?? '');
}

type ForeignKey = SqlStatement & {
  readonly table: string;
  readonly column: string;
};

const ADD_CONSTRAINT = new RegExp(
  String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+add\s+(?:constraint\s+${IDENT}\s+)?(foreign\s+key|primary\s+key|unique)\s*\(([^)]*)\)`,
  'iu',
);
const CREATE_INDEX = new RegExp(
  String.raw`^create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:${IDENT}\s+)?on\s+(?:only\s+)?${NAME}\s*(?:using\s+\w+\s*)?\(\s*${IDENT}`,
  'iu',
);

/** PD053: a foreign key no index starts with, so joins and deletes on the referenced row scan the table. */
export function pd053(
  cwd: string,
  config: PermDockConfig,
): readonly DoctorFinding[] {
  if (!isSupabase(cwd, config)) {
    return [];
  }
  const keys: ForeignKey[] = [];
  const indexed = new Set<string>();
  for (const statement of migrationStatements(cwd, config)) {
    const table = CREATE_TABLE.exec(statement.text);
    if (table !== null) {
      const key = tableKey(table[1] ?? '');
      const open = statement.text.indexOf('(', table[0].length - 1);
      const body = statement.text.slice(
        open + 1,
        statement.text.lastIndexOf(')'),
      );
      for (const raw of topLevelParts(body)) {
        const found = tablePart(raw);
        if (found.foreign) {
          keys.push({ ...statement, table: key, column: found.column });
        }
        if (found.indexed) {
          indexed.add(`${key}.${found.column}`);
        }
      }
      continue;
    }
    const added = ADD_CONSTRAINT.exec(statement.text);
    if (added !== null) {
      const key = tableKey(added[1] ?? '');
      const column = firstColumn(added[4] ?? '');
      if (/^foreign/iu.test(added[3] ?? '')) {
        keys.push({ ...statement, table: key, column });
      } else {
        indexed.add(`${key}.${column}`);
      }
      continue;
    }
    const index = CREATE_INDEX.exec(statement.text);
    if (index !== null) {
      indexed.add(`${tableKey(index[2] ?? '')}.${unquote(index[3] ?? '')}`);
    }
  }
  return keys
    .filter((fk) => !indexed.has(`${fk.table}.${fk.column}`))
    .map((fk) => ({
      code: 'PD053',
      severity: 'warning',
      message: `${fk.file}:${String(fk.line)} ${fk.table}.${fk.column} is a foreign key no index starts with, so policies that join on it and deletes of the referenced row scan ${fk.table}`,
      fix: `create index on ${fk.table} (${fk.column}); (Supabase advisor unindexed_foreign_keys)`,
    }));
}
