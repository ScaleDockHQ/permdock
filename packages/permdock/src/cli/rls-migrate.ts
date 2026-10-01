import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse } from 'pgsql-parser';

import type { GenerateOutcome } from './rls-generate.ts';
import type { RlsMigrateConfig, RlsMigrateHelper } from './types.ts';

import { HELPERS } from './rls-helpers.ts';

/** One call `rls migrate` rewrote, or would with `--write`. */
export type MigrateRewrite = {
  readonly file: string;
  readonly line: number;
  readonly from: string;
  readonly to: string;
};

/** Why a call was left as written. */
export type MigrateSkipReason =
  | 'unknown-key'
  | 'row-conditions'
  | 'not-granted-on-scope'
  | 'missing-helper'
  | 'dynamic-key'
  | 'not-a-column'
  | 'unknown-scope'
  | 'function-body'
  | 'not-in-policy'
  | 'unparsed';

export type MigrateSkip = {
  readonly file: string;
  readonly line: number;
  readonly call: string;
  readonly reason: MigrateSkipReason;
  readonly detail: string;
};

export type MigrateReport = {
  readonly rewrites: readonly MigrateRewrite[];
  readonly skipped: readonly MigrateSkip[];
};

/** What the rewrite checks a key and a helper name against: `rls generate`'s own output. */
export type MigrateTarget = {
  readonly schema: string;
  readonly sql: string;
  readonly permissions: ReadonlySet<string>;
  readonly rowConditions: ReadonlySet<string>;
  /** `grant_key` by scope, from the seeded `role_permissions` rows. */
  readonly granted: ReadonlyMap<string, ReadonlySet<string>>;
};

export function migrateTarget(generated: GenerateOutcome): MigrateTarget {
  const granted = new Map<string, Set<string>>();
  for (const row of generated.seeds ?? []) {
    if (row.effect !== 'allow') {
      continue;
    }
    let keys = granted.get(row.scope);
    if (keys === undefined) {
      keys = new Set();
      granted.set(row.scope, keys);
    }
    keys.add(row.grantKey);
  }
  return {
    schema: generated.schema ?? 'public',
    sql: generated.text,
    permissions: new Set(generated.keys?.permissions ?? []),
    rowConditions: new Set(generated.keys?.rowConditions ?? []),
    granted,
  };
}

type Node = Readonly<Record<string, unknown>>;

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function child(node: unknown, key: string): unknown {
  return isNode(node) ? node[key] : undefined;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** libpg_query reports byte offsets; this maps them onto string indices. */
function charIndex(text: string): (byte: number) => number {
  if (Buffer.byteLength(text) === text.length) {
    return (byte) => byte;
  }
  const map: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index) ?? 0;
    const size = Buffer.byteLength(String.fromCodePoint(code));
    for (let byte = 0; byte < size; byte += 1) {
      map.push(index);
    }
    if (code > 0xff_ff) {
      index += 1;
    }
  }
  return (byte) => map[byte] ?? text.length;
}

/** The index just past the `)` closing the call that starts at `start`. */
function callEnd(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" || char === '"') {
      const close = text.indexOf(char, index + 1);
      if (close === -1) {
        return -1;
      }
      index = close;
      continue;
    }
    if (char === '-' && text[index + 1] === '-') {
      const close = text.indexOf('\n', index);
      index = close === -1 ? text.length : close;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? text.length : close + 1;
      continue;
    }
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return -1;
}

const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const COLUMN = new RegExp(
  String.raw`${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})*`,
  'uy',
);

function columnText(text: string, start: number): string | undefined {
  COLUMN.lastIndex = start;
  return COLUMN.exec(text)?.[0];
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1 && at < index;) {
    line += 1;
    at = text.indexOf('\n', at + 1);
  }
  return line;
}

function stringConst(node: unknown): string | undefined {
  const value = child(child(child(node, 'A_Const'), 'sval'), 'sval');
  return typeof value === 'string' ? value : undefined;
}

function isNullConst(node: unknown): boolean {
  return child(child(node, 'A_Const'), 'isnull') === true;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The PermDock key for a legacy one: `keys` first, then the longest matching prefix. */
export function mapKey(config: RlsMigrateConfig, key: string): string {
  const exact = config.keys?.[key];
  if (exact !== undefined) {
    return exact;
  }
  const prefix = Object.keys(config.prefixes ?? {})
    .filter((candidate) => key.startsWith(candidate))
    .toSorted((a, b) => b.length - a.length)[0];
  return prefix === undefined
    ? key
    : `${config.prefixes?.[prefix] ?? ''}${key.slice(prefix.length)}`;
}

type Call = {
  readonly name: string;
  readonly helper: RlsMigrateHelper;
  readonly args: readonly unknown[];
  readonly start: number;
  readonly end: number;
};

type Outcome =
  | { readonly to: string }
  | { readonly reason: MigrateSkipReason; readonly detail: string };

function skip(reason: MigrateSkipReason, detail: string): Outcome {
  return { reason, detail };
}

class Rewriter {
  readonly #config: RlsMigrateConfig;
  readonly #target: MigrateTarget;
  readonly #text: string;
  readonly #at: (byte: number) => number;

  public constructor(
    config: RlsMigrateConfig,
    target: MigrateTarget,
    text: string,
  ) {
    this.#config = config;
    this.#target = target;
    this.#text = text;
    this.#at = charIndex(text);
  }

  #helper(name: string): string | undefined {
    const { schema, sql } = this.#target;
    const quoted = `"${schema.replaceAll('"', '""')}"`;
    if (!sql.includes(`function ${quoted}.${name}(`)) {
      return undefined;
    }
    return /^[a-z_][a-z0-9_$]*$/u.test(schema)
      ? `${schema}.${name}`
      : `${quoted}.${name}`;
  }

  #key(arg: unknown, scope: string): Outcome {
    const legacy = stringConst(arg);
    if (legacy === undefined) {
      return skip(
        'dynamic-key',
        'the key is not a string literal; map it by hand',
      );
    }
    const key = mapKey(this.#config, legacy);
    if (!this.#target.permissions.has(key)) {
      return skip(
        'unknown-key',
        `${legacy} maps to ${key}, which the policy does not declare; add it to rls.migrate.keys or the vocabulary`,
      );
    }
    if (this.#target.rowConditions.has(key)) {
      return skip(
        'row-conditions',
        `${key} has row conditions the helper cannot apply; let rls generate write this table's policy`,
      );
    }
    if (this.#target.granted.get(scope)?.has(key) !== true) {
      const seeded = [...this.#target.granted.values()].some((keys) =>
        keys.has(key),
      );
      return skip(
        'not-granted-on-scope',
        seeded
          ? `no role grants ${key} on ${scope}, so the helper would always deny`
          : `${key} has no role_permissions row: rls generate seeds only read, list, get, create, update and delete grants`,
      );
    }
    return { to: literal(key) };
  }

  #column(arg: unknown): Outcome {
    const ref = child(arg, 'ColumnRef');
    const location = child(ref, 'location');
    if (typeof location !== 'number') {
      return skip(
        'not-a-column',
        'the id is an expression, not a plain column; rewrite it by hand',
      );
    }
    const text = columnText(this.#text, this.#at(location));
    return text === undefined
      ? skip('not-a-column', 'the id could not be read as a column')
      : { to: text };
  }

  #ids(scope: string, keyArg: unknown): Outcome {
    const helper = this.#helper(`permitted_${scope}_ids`);
    if (helper === undefined) {
      return skip(
        'missing-helper',
        `rls generate writes no permitted_${scope}_ids for this policy`,
      );
    }
    const key = this.#key(keyArg, scope);
    return 'to' in key ? { to: `${helper}(${key.to})` } : key;
  }

  #row(scope: string, idArg: unknown, keyArg: unknown): Outcome {
    const column = this.#column(idArg);
    if (!('to' in column)) {
      return column;
    }
    const ids = this.#ids(scope, keyArg);
    return 'to' in ids ? { to: `(${column.to} in (select ${ids.to}))` } : ids;
  }

  #global(keyArg: unknown, selected: boolean): Outcome {
    const helper = this.#helper(HELPERS.has);
    if (helper === undefined) {
      return skip('missing-helper', `rls generate writes no ${HELPERS.has}`);
    }
    const key = this.#key(keyArg, 'global');
    if (!('to' in key)) {
      return key;
    }
    const call = `${helper}(${key.to})`;
    return { to: selected ? call : `(select ${call})` };
  }

  #membership(scope: string, idArg: unknown): Outcome {
    const helper = this.#helper(`member_${scope}_ids`);
    if (helper === undefined) {
      return skip(
        'missing-helper',
        `rls generate writes no member_${scope}_ids: ${scope} has no membership source`,
      );
    }
    const column = this.#column(idArg);
    return 'to' in column
      ? { to: `(${column.to} in (select ${helper}()))` }
      : column;
  }

  #scoped(args: readonly unknown[], selected: boolean): Outcome {
    const [scopeArg, idArg, keyArg] = args;
    const named = stringConst(scopeArg);
    if (named === undefined) {
      return skip(
        'unknown-scope',
        'the scope is not a string literal; rewrite it by hand',
      );
    }
    if (
      this.#config.globalScopes?.includes(named) === true ||
      isNullConst(idArg)
    ) {
      return this.#global(keyArg, selected);
    }
    return this.#row(this.#config.scopes?.[named] ?? named, idArg, keyArg);
  }

  /** `selected`: the call is already a `select` target, so `permdock_has` needs no wrapping subquery. */
  public rewrite(call: Call, selected: boolean): Outcome {
    const { helper, args } = call;
    switch (helper.form) {
      case 'ids':
        return this.#ids(helper.scope, args[0]);
      case 'row':
        return this.#row(helper.scope, args[0], args[1]);
      case 'membership':
        return this.#membership(helper.scope, args[0]);
      case 'scoped':
        return this.#scoped(args, selected);
      case 'global':
        return this.#global(args[0], selected);
      default: {
        const unhandled: never = helper;
        return unhandled;
      }
    }
  }

  public call(node: Node): Call | undefined {
    const name = list(node['funcname'])
      .map((part) => child(child(part, 'String'), 'sval'))
      .at(-1);
    const location = node['location'];
    if (typeof name !== 'string' || typeof location !== 'number') {
      return undefined;
    }
    const helper = this.#config.helpers[name];
    if (helper === undefined) {
      return undefined;
    }
    const start = this.#at(location);
    return {
      name,
      helper,
      args: list(node['args']),
      start,
      end: callEnd(this.#text, start),
    };
  }
}

const POLICY_STATEMENTS = new Set(['CreatePolicyStmt', 'AlterPolicyStmt']);
const BODY_STATEMENTS = new Set(['CreateFunctionStmt', 'DoStmt']);

function bodyStrings(statement: unknown): readonly string[] {
  const options = [
    ...list(child(statement, 'options')),
    ...list(child(statement, 'args')),
  ];
  const found: string[] = [];
  for (const option of options) {
    const element = child(option, 'DefElem');
    if (child(element, 'defname') !== 'as') {
      continue;
    }
    const arg = child(element, 'arg');
    const items = [
      child(arg, 'String'),
      ...list(child(child(arg, 'List'), 'items')).map((item) =>
        child(item, 'String'),
      ),
    ];
    for (const item of items) {
      const value = child(item, 'sval');
      if (typeof value === 'string') {
        found.push(value);
      }
    }
  }
  return found;
}

/** Rewrites the configured helper calls in one file's policies; everything else is reported. */
async function migrateSql(
  file: string,
  text: string,
  config: RlsMigrateConfig,
  target: MigrateTarget,
): Promise<MigrateReport & { readonly text: string }> {
  const rewrites: MigrateRewrite[] = [];
  const skipped: MigrateSkip[] = [];
  const names = Object.keys(config.helpers);
  if (!names.some((name) => text.includes(name))) {
    return { rewrites, skipped, text };
  }
  let tree: unknown;
  try {
    tree = await parse(text);
  } catch (cause) {
    skipped.push({
      file,
      line: 1,
      call: '',
      reason: 'unparsed',
      detail: `the file does not parse: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
    return { rewrites, skipped, text };
  }
  const rewriter = new Rewriter(config, target, text);
  const at = charIndex(text);
  const edits: { start: number; end: number; to: string }[] = [];
  const called = new RegExp(
    String.raw`\b(${names.map((name) => name.replaceAll(/[$]/gu, String.raw`\$`)).join('|')})\s*\(`,
    'gu',
  );

  const visit = (node: unknown, inPolicy: boolean, selected = false): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, inPolicy);
      }
      return;
    }
    if (!isNode(node)) {
      return;
    }
    for (const [kind, value] of Object.entries(node)) {
      if (kind === 'FuncCall' && isNode(value)) {
        const call = rewriter.call(value);
        if (call !== undefined) {
          const source =
            call.end === -1 ? call.name : text.slice(call.start, call.end);
          const line = lineOf(text, call.start);
          if (!inPolicy) {
            skipped.push({
              file,
              line,
              call: source,
              reason: 'not-in-policy',
              detail:
                'the call is outside a create or alter policy; rewrite it by hand',
            });
            continue;
          }
          const outcome =
            call.end === -1
              ? skip('not-a-column', 'the call could not be delimited')
              : rewriter.rewrite(call, selected);
          if ('to' in outcome) {
            edits.push({ start: call.start, end: call.end, to: outcome.to });
            rewrites.push({ file, line, from: source, to: outcome.to });
          } else {
            skipped.push({ file, line, call: source, ...outcome });
          }
          continue;
        }
      }
      visit(
        value,
        inPolicy || POLICY_STATEMENTS.has(kind),
        kind === 'ResTarget' || (selected && kind === 'val'),
      );
    }
  };

  for (const raw of list(child(tree, 'stmts'))) {
    const statement = child(raw, 'stmt');
    const offset = child(raw, 'stmt_location');
    const statementStart = at(typeof offset === 'number' ? offset : 0);
    const kind = isNode(statement) ? Object.keys(statement)[0] : undefined;
    if (kind !== undefined && BODY_STATEMENTS.has(kind)) {
      for (const body of bodyStrings(child(statement, kind))) {
        const bodyStart = text.indexOf(body, statementStart);
        for (const match of body.matchAll(called)) {
          skipped.push({
            file,
            line: lineOf(
              text,
              (bodyStart === -1 ? statementStart : bodyStart) +
                (match.index ?? 0),
            ),
            call: match[1] ?? '',
            reason: 'function-body',
            detail:
              'the call is inside a function body, which runs with its own privileges; rewrite it by hand',
          });
        }
      }
      continue;
    }
    visit(statement, false);
  }

  let out = text;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    out = `${out.slice(0, edit.start)}${edit.to}${out.slice(edit.end)}`;
  }
  return { rewrites, skipped, text: out };
}

function sqlFiles(path: string): readonly string[] {
  if (!statSync(path).isDirectory()) {
    return [path];
  }
  return readdirSync(path, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.sql'))
    .toSorted()
    .map((entry) => join(path, entry));
}

export type MigrateRunInput = {
  readonly cwd: string;
  readonly sql: string;
  readonly config: RlsMigrateConfig;
  readonly target: MigrateTarget;
  readonly write: boolean;
  readonly json: boolean;
};

function describe(report: MigrateReport, write: boolean): string {
  const lines = [
    ...report.rewrites.map(
      (item) =>
        `${item.file}:${String(item.line)}  ${item.from}  ->  ${item.to}`,
    ),
    ...report.skipped.map(
      (item) =>
        `skipped ${item.file}:${String(item.line)}  ${item.call}: ${item.detail}`,
    ),
  ];
  const files = new Set(report.rewrites.map((item) => item.file)).size;
  const unknown = report.skipped.filter(
    (item) => item.reason === 'unknown-key',
  ).length;
  lines.push(
    `rls migrate: ${write ? 'rewrote' : 'would rewrite'} ${String(report.rewrites.length)} call(s) in ${String(files)} file(s), skipped ${String(report.skipped.length)}${unknown === 0 ? '' : `, ${String(unknown)} with an unknown key`}${write ? '' : '; --write applies them'}`,
  );
  return lines.join('\n');
}

/** `permdock rls migrate`: a dry run unless `write`; exits 1 while a key is unknown. */
export async function runRlsMigrate(
  input: MigrateRunInput,
): Promise<{ readonly code: 0 | 1 | 2; readonly output: string }> {
  const root = resolve(input.cwd, input.sql);
  let files: readonly string[];
  try {
    files = sqlFiles(root);
  } catch {
    return {
      code: 2,
      output: `rls migrate --sql: ${input.sql} does not exist`,
    };
  }
  const rewrites: MigrateRewrite[] = [];
  const skipped: MigrateSkip[] = [];
  for (const path of files) {
    const file = relative(input.cwd, path);
    const text = readFileSync(path, 'utf8');
    const result = await migrateSql(file, text, input.config, input.target);
    rewrites.push(...result.rewrites);
    skipped.push(...result.skipped);
    if (input.write && result.text !== text) {
      writeFileSync(path, result.text);
    }
  }
  const report = { rewrites, skipped };
  const code = skipped.some((item) => item.reason === 'unknown-key') ? 1 : 0;
  return {
    code,
    output: input.json
      ? JSON.stringify(report, undefined, 2)
      : describe(report, input.write),
  };
}
