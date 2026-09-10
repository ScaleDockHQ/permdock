import { readFileSync } from 'node:fs';
import { parseSync } from 'oxc-parser';

import type { CatalogUsage, DynamicUsage, ScanResult } from './types.ts';

import { rel } from './files.ts';

const CHECK_CALLS = new Set([
  'can',
  'decide',
  'assert',
  'filter',
  'where',
  'simulate',
  'actions',
  'usePermission',
  'getPermission',
  'protect',
  'allow',
  'deny',
  'registerTool',
  'anyone',
  'authenticated',
  'relation',
  'plan',
  'actor',
  'assurance',
]);

type Estree = {
  readonly type?: string;
  readonly name?: string;
  readonly value?: unknown;
  readonly start?: number;
  readonly object?: Estree;
  readonly property?: Estree;
  readonly computed?: boolean;
  readonly callee?: Estree;
  readonly arguments?: readonly Estree[];
  readonly init?: Estree;
  readonly id?: Estree;
  readonly source?: Estree;
  readonly specifiers?: readonly Estree[];
  readonly local?: Estree;
  readonly imported?: Estree;
  readonly declaration?: Estree;
  readonly declarations?: readonly Estree[];
  readonly body?: Estree | readonly Estree[];
  readonly properties?: readonly Estree[];
  readonly key?: Estree;
};

export function scanSources(
  cwd: string,
  files: readonly string[],
  knownKeys: ReadonlySet<string>,
): ScanResult {
  const roots = new Set<string>(['permissions']);
  const definitionFiles: Record<string, string> = {};
  const usages: Record<string, CatalogUsage[]> = {};
  const unknown: CatalogUsage[] = [];
  const dynamic: DynamicUsage[] = [];
  const roleNames = new Set<string>();
  const planNames = new Set<string>();
  const allowKeys = new Set<string>();

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    let program: Estree;
    try {
      const parsed = parseSync(file, source);
      program = parsed.program as Estree;
    } catch {
      continue;
    }
    const fileRel = rel(cwd, file);
    walk(program, undefined, (node, parent) => {
      if (node.type === 'CallExpression') {
        recordCall(
          node,
          parent,
          source,
          fileRel,
          roots,
          definitionFiles,
          usages,
          unknown,
          dynamic,
          roleNames,
          planNames,
          allowKeys,
          knownKeys,
        );
      }
      if (
        node.type === 'MemberExpression' &&
        parent?.type !== 'MemberExpression'
      ) {
        recordMember(
          node,
          parent,
          source,
          fileRel,
          roots,
          usages,
          unknown,
          dynamic,
          allowKeys,
          knownKeys,
        );
      }
      if (node.type === 'ImportDeclaration') {
        recordImport(node, roots);
      }
    });
  }

  return {
    roots: [...roots].toSorted(),
    definitionFiles,
    usages,
    unknown,
    dynamic,
    roleNames: [...roleNames].toSorted(),
    planNames: [...planNames].toSorted(),
    allowKeys: [...allowKeys].toSorted(),
  };
}

function recordImport(node: Estree, roots: Set<string>): void {
  for (const spec of node.specifiers ?? []) {
    const imported = spec.imported?.name ?? spec.local?.name;
    const local = spec.local?.name;
    if (imported === 'permissions' && local !== undefined) {
      roots.add(local);
    }
  }
}

function recordCall(
  node: Estree,
  parent: Estree | undefined,
  source: string,
  fileRel: string,
  roots: Set<string>,
  definitionFiles: Record<string, string>,
  usages: Record<string, CatalogUsage[]>,
  unknown: CatalogUsage[],
  dynamic: DynamicUsage[],
  roleNames: Set<string>,
  planNames: Set<string>,
  _allowKeys: Set<string>,
  knownKeys: ReadonlySet<string>,
): void {
  const callee = calleeName(node.callee);
  const line = lineAt(source, node.start ?? 0);
  if (
    callee === 'definePermissions' ||
    callee === 'defineRoles' ||
    callee === 'definePlans'
  ) {
    const name = declaredName(parent);
    if (name !== undefined) {
      roots.add(name);
      definitionFiles[name] = fileRel;
    }
    if (callee === 'defineRoles') {
      collectObjectKeys(node.arguments?.[0], roleNames);
    }
    if (callee === 'definePlans') {
      collectObjectKeys(node.arguments?.[0], planNames);
    }
    return;
  }
  if (callee === 'role') {
    const first = node.arguments?.[0];
    if (typeof first?.value === 'string') {
      roleNames.add(first.value);
    } else if (
      first?.type === 'MemberExpression' &&
      typeof first.property?.name === 'string'
    ) {
      roleNames.add(first.property.name);
    }
    return;
  }
  if (callee === 'findPermission') {
    const second = node.arguments?.[1];
    if (typeof second?.value === 'string') {
      pushUsage(
        second.value,
        { file: fileRel, line, call: 'findPermission' },
        knownKeys,
        usages,
        unknown,
      );
      return;
    }
    dynamic.push({ file: fileRel, line, call: 'findPermission' });
  }
}

function recordMember(
  node: Estree,
  parent: Estree | undefined,
  source: string,
  fileRel: string,
  roots: Set<string>,
  usages: Record<string, CatalogUsage[]>,
  unknown: CatalogUsage[],
  dynamic: DynamicUsage[],
  allowKeys: Set<string>,
  knownKeys: ReadonlySet<string>,
): void {
  if (node.computed === true) {
    const root = rootName(node);
    if (root !== undefined && roots.has(root)) {
      dynamic.push({
        file: fileRel,
        line: lineAt(source, node.start ?? 0),
        call: callName(parent),
      });
    }
    return;
  }
  const path = memberPath(node);
  if (path === undefined || path.length < 2) {
    return;
  }
  const [root, ...rest] = path;
  if (root === undefined || !roots.has(root)) {
    return;
  }
  const key = rest.join('.');
  const call = callName(parent);
  const usage = {
    file: fileRel,
    line: lineAt(source, node.start ?? 0),
    call,
  };
  if (call === 'allow') {
    allowKeys.add(key);
  }
  pushUsage(key, usage, knownKeys, usages, unknown);
}

function pushUsage(
  key: string,
  usage: CatalogUsage,
  knownKeys: ReadonlySet<string>,
  usages: Record<string, CatalogUsage[]>,
  unknown: CatalogUsage[],
): void {
  if (knownKeys.size > 0 && !knownKeys.has(key)) {
    unknown.push({ ...usage, call: `${usage.call}:${key}` });
    return;
  }
  const list = usages[key] ?? [];
  list.push(usage);
  usages[key] = list;
}

function calleeName(node: Estree | undefined): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (node.type === 'Identifier') {
    return node.name;
  }
  if (
    node.type === 'MemberExpression' &&
    node.property?.type === 'Identifier'
  ) {
    return node.property.name;
  }
  return undefined;
}

function declaredName(parent: Estree | undefined): string | undefined {
  if (
    parent?.type === 'VariableDeclarator' &&
    parent.id?.type === 'Identifier'
  ) {
    return parent.id.name;
  }
  return undefined;
}

function callName(parent: Estree | undefined): string {
  if (parent?.type === 'CallExpression') {
    const name = calleeName(parent.callee);
    if (name !== undefined && CHECK_CALLS.has(name)) {
      return name;
    }
  }
  if (parent?.type === 'Property' || parent?.type === 'ObjectProperty') {
    return 'tools';
  }
  return 'reference';
}

function memberPath(node: Estree): string[] | undefined {
  const parts: string[] = [];
  let current: Estree | undefined = node;
  while (current?.type === 'MemberExpression') {
    if (current.computed === true) {
      return undefined;
    }
    const name = current.property?.name;
    if (name === undefined) {
      return undefined;
    }
    parts.unshift(name);
    current = current.object;
  }
  if (current?.type !== 'Identifier' || current.name === undefined) {
    return undefined;
  }
  parts.unshift(current.name);
  return parts;
}

function rootName(node: Estree): string | undefined {
  let current: Estree | undefined = node;
  while (current?.type === 'MemberExpression') {
    current = current.object;
  }
  return current?.type === 'Identifier' ? current.name : undefined;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  const end = Math.min(index, source.length);
  for (let i = 0; i < end; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function collectObjectKeys(node: Estree | undefined, into: Set<string>): void {
  if (node?.type !== 'ObjectExpression' || node.properties === undefined) {
    return;
  }
  for (const property of node.properties) {
    const key = property.key;
    if (typeof key?.name === 'string') {
      into.add(key.name);
      continue;
    }
    if (typeof key?.value === 'string') {
      into.add(key.value);
    }
  }
}

function walk(
  node: Estree | undefined,
  parent: Estree | undefined,
  visit: (node: Estree, parent: Estree | undefined) => void,
): void {
  if (
    node === undefined ||
    typeof node !== 'object' ||
    node.type === undefined
  ) {
    return;
  }
  visit(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item as Estree, node, visit);
      }
      continue;
    }
    if (value !== null && typeof value === 'object' && 'type' in value) {
      walk(value as Estree, node, visit);
    }
  }
}

export function allowKeysFromScan(
  cwd: string,
  files: readonly string[],
): readonly string[] {
  const keys = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    let program: Estree;
    try {
      program = parseSync(file, source).program as Estree;
    } catch {
      continue;
    }
    walk(program, undefined, (node) => {
      if (
        node.type !== 'CallExpression' ||
        calleeName(node.callee) !== 'allow'
      ) {
        return;
      }
      const first = node.arguments?.[0];
      if (first === undefined) {
        return;
      }
      const path = memberPath(first);
      if (path !== undefined && path.length >= 2) {
        keys.add(path.slice(1).join('.'));
      }
    });
  }
  void cwd;
  return [...keys].toSorted();
}
