import { readFileSync } from "node:fs";
import {
  type Program,
  type VisitorObject,
  Visitor,
  parseSync,
  visitorKeys,
} from "oxc-parser";

import type {
  CatalogUsage,
  DynamicUsage,
  ScanResult,
  SnapshotSite,
  UnparsedSource,
} from "./types.ts";

import { describeError } from "./errors.ts";
import { rel } from "./files.ts";

/** oxc reports recoverable problems as `Warning` or `Advice`; only `Error` leaves the program incomplete. */
const PARSE_ERRORS: ReadonlySet<string> = new Set(["Error"]);

const CHECK_CALLS = new Set([
  "can",
  "decide",
  "assert",
  "filter",
  "where",
  "simulate",
  "actions",
  "usePermission",
  "getPermission",
  "protect",
  "allow",
  "deny",
  "registerTool",
  "anyone",
  "authenticated",
  "relation",
  "plan",
  "actor",
  "assurance",
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
  readonly init?: Estree | null;
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
  readonly elements?: readonly (Estree | null)[];
  readonly params?: readonly Estree[];
  readonly param?: Estree | null;
  readonly parameter?: Estree;
  readonly left?: Estree;
  readonly argument?: Estree | null;
  readonly cases?: readonly Estree[];
  readonly consequent?: Estree | readonly Estree[];
};

/** Whether an identifier, where it is read, is bound to a permission tree. */
type RootTest = (name: string) => boolean;

export function scanSources(
  cwd: string,
  files: readonly string[],
  knownKeys: ReadonlySet<string>,
): ScanResult {
  const roots = new Set<string>(["permissions"]);
  const definitionFiles: Record<string, string> = {};
  const usages: Record<string, CatalogUsage[]> = {};
  const unknown: CatalogUsage[] = [];
  const dynamic: DynamicUsage[] = [];
  const roleNames = new Set<string>();
  const planNames = new Set<string>();
  const allowKeys = new Set<string>();
  const snapshots: SnapshotSite[] = [];
  const unparsed: UnparsedSource[] = [];

  const parsed: {
    readonly file: string;
    readonly source: string;
    readonly program: Program;
  }[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const fileRel = rel(cwd, file);
    try {
      const result = parseSync(file, source);
      const error = result.errors.find((item) =>
        PARSE_ERRORS.has(item.severity),
      );
      if (error !== undefined) {
        unparsed.push({
          file: fileRel,
          line: lineIndex(source)(error.labels[0]?.start ?? 0),
          message: error.message,
        });
      }
      parsed.push({ file, source, program: result.program });
    } catch (error) {
      unparsed.push({
        file: fileRel,
        line: 1,
        message: describeError(error),
      });
    }
  }
  // Every `definePermissions` binding name, so an import of one resolves in any file.
  const definitions = new Set<string>(["permissions"]);
  for (const { program } of parsed) {
    walk(program, (node) => {
      if (
        node.type === "VariableDeclarator" &&
        node.id?.type === "Identifier" &&
        node.id.name !== undefined &&
        isDefinePermissions(node.init)
      ) {
        definitions.add(node.id.name);
      }
    });
  }

  for (const { file, source, program } of parsed) {
    const fileRel = rel(cwd, file);
    const lineAt = lineIndex(source);
    const scopes = new WeakMap<Estree, ReadonlyMap<string, boolean>>();
    walk(program, (node, parent, ancestors) => {
      const isRoot: RootTest = (name) =>
        boundToRoot(name, ancestors, definitions, scopes);
      if (node.type === "CallExpression") {
        recordCall(
          node,
          parent,
          lineAt,
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
        const callee = calleeName(node.callee);
        if (callee === "snapshot" || callee === "snapshotFor") {
          snapshots.push({
            file: fileRel,
            line: lineAt(node.start ?? 0),
            include: includeOf(
              node.arguments?.[callee === "snapshot" ? 0 : 2],
              isRoot,
            ),
          });
        }
      }
      if (
        node.type === "MemberExpression" &&
        parent?.type !== "MemberExpression"
      ) {
        recordMember(
          node,
          parent,
          lineAt,
          fileRel,
          isRoot,
          usages,
          unknown,
          dynamic,
          allowKeys,
          knownKeys,
        );
      }
      if (node.type === "ImportDeclaration") {
        recordImport(node, roots, definitions);
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
    snapshots,
    unparsed,
  };
}

function includeOf(
  options: Estree | undefined,
  isRoot: RootTest,
): readonly string[] | null | undefined {
  if (options?.type !== "ObjectExpression") {
    return options === undefined ? undefined : null;
  }
  const property = options.properties?.find(
    (item) => item.key?.name === "include",
  );
  if (property === undefined) {
    return options.properties?.some((item) => item.type === "SpreadElement")
      ? null
      : undefined;
  }
  // SAFETY: a Property's value is an ESTree node; its type is checked on the next line.
  const list = property.value as Estree | undefined;
  if (list?.type !== "ArrayExpression") {
    return null;
  }
  const keys: string[] = [];
  for (const element of list.elements ?? []) {
    const path =
      element?.type === "MemberExpression" ? memberPath(element) : undefined;
    const [root, ...rest] = path ?? [];
    if (root === undefined || !isRoot(root) || rest.length === 0) {
      return null;
    }
    keys.push(rest.join("."));
  }
  return keys;
}

function recordImport(
  node: Estree,
  roots: Set<string>,
  definitions: ReadonlySet<string>,
): void {
  for (const spec of node.specifiers ?? []) {
    const local = spec.local?.name;
    if (local !== undefined && importsRoot(spec, definitions)) {
      roots.add(local);
    }
  }
}

function isDefinePermissions(node: Estree | null | undefined): boolean {
  return (
    node?.type === "CallExpression" &&
    calleeName(node.callee) === "definePermissions"
  );
}

/** An import binding of a permission tree: by its imported name, or a default import named `permissions`. */
function importsRoot(spec: Estree, definitions: ReadonlySet<string>): boolean {
  if (spec.type === "ImportSpecifier") {
    const value = spec.imported?.value;
    const imported = typeof value === "string" ? value : spec.imported?.name;
    return imported !== undefined && definitions.has(imported);
  }
  return (
    spec.type === "ImportDefaultSpecifier" && spec.local?.name === "permissions"
  );
}

function patternNames(
  pattern: Estree | null | undefined,
  into: string[],
): void {
  if (pattern === null || pattern === undefined) {
    return;
  }
  const type = pattern.type;
  if (type === "Identifier" && pattern.name !== undefined) {
    into.push(pattern.name);
  } else if (type === "ObjectPattern") {
    for (const property of pattern.properties ?? []) {
      // SAFETY: a pattern Property's value is the bound pattern node.
      const value = property.value as Estree | undefined;
      patternNames(
        property.type === "RestElement" ? property.argument : value,
        into,
      );
    }
  } else if (type === "ArrayPattern") {
    for (const element of pattern.elements ?? []) {
      patternNames(element, into);
    }
  } else {
    patternNames(pattern.left ?? pattern.argument ?? pattern.parameter, into);
  }
}

const NAMED_DECLARATIONS: ReadonlySet<string | undefined> = new Set([
  "FunctionDeclaration",
  "ClassDeclaration",
  "TSEnumDeclaration",
]);

function declareStatement(
  statement: Estree,
  bindings: Map<string, boolean>,
  definitions: ReadonlySet<string>,
): void {
  const type = statement.type;
  if (type === "VariableDeclaration") {
    for (const declarator of statement.declarations ?? []) {
      const names: string[] = [];
      patternNames(declarator.id, names);
      const root =
        declarator.id?.type === "Identifier" &&
        isDefinePermissions(declarator.init);
      for (const name of names) {
        bindings.set(name, root);
      }
    }
  } else if (NAMED_DECLARATIONS.has(type)) {
    if (statement.id?.name !== undefined) {
      bindings.set(statement.id.name, false);
    }
  } else if (
    type === "ExportNamedDeclaration" ||
    type === "ExportDefaultDeclaration"
  ) {
    const declaration: Estree | null | undefined = statement.declaration;
    if (declaration !== undefined && declaration !== null) {
      declareStatement(declaration, bindings, definitions);
    }
  } else if (type === "ImportDeclaration") {
    for (const spec of statement.specifiers ?? []) {
      if (spec.local?.name !== undefined) {
        bindings.set(spec.local.name, importsRoot(spec, definitions));
      }
    }
  }
}

function isNodeList(value: unknown): value is readonly Estree[] {
  return Array.isArray(value);
}

const BLOCK_SCOPES: ReadonlySet<string | undefined> = new Set([
  "Program",
  "BlockStatement",
  "StaticBlock",
]);

const FUNCTION_SCOPES: ReadonlySet<string | undefined> = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** The names a scope node declares, each with whether it is a permission tree; `undefined` for a node that opens no scope. */
function bindingsOf(
  node: Estree,
  definitions: ReadonlySet<string>,
): ReadonlyMap<string, boolean> | undefined {
  const bindings = new Map<string, boolean>();
  const type = node.type;
  const declare = (statements: unknown): void => {
    for (const statement of isNodeList(statements) ? statements : []) {
      declareStatement(statement, bindings, definitions);
    }
  };
  const names: string[] = [];
  if (BLOCK_SCOPES.has(type)) {
    declare(node.body);
  } else if (FUNCTION_SCOPES.has(type)) {
    for (const param of node.params ?? []) {
      patternNames(param, names);
    }
    if (type === "FunctionExpression") {
      patternNames(node.id, names);
    }
  } else if (type === "ForStatement") {
    declare(node.init === null || node.init === undefined ? [] : [node.init]);
  } else if (type === "ForInStatement" || type === "ForOfStatement") {
    declare(node.left === undefined ? [] : [node.left]);
  } else if (type === "CatchClause") {
    patternNames(node.param, names);
  } else if (type === "SwitchStatement") {
    for (const branch of node.cases ?? []) {
      declare(branch.consequent);
    }
  } else {
    return undefined;
  }
  for (const name of names) {
    bindings.set(name, false);
  }
  return bindings;
}

/**
 * Whether `name`, read inside `ancestors`, is bound to a permission tree: the
 * innermost scope that declares it decides. A name no scope declares keeps
 * matching by name, as a global or generated reference does.
 */
function boundToRoot(
  name: string,
  ancestors: readonly Estree[],
  definitions: ReadonlySet<string>,
  cache: WeakMap<Estree, ReadonlyMap<string, boolean>>,
): boolean {
  for (const scope of ancestors.toReversed()) {
    let bindings = cache.get(scope);
    if (bindings === undefined) {
      const found = bindingsOf(scope, definitions);
      if (found === undefined) {
        continue;
      }
      bindings = found;
      cache.set(scope, bindings);
    }
    const bound = bindings.get(name);
    if (bound !== undefined) {
      return bound;
    }
  }
  return definitions.has(name);
}

function recordCall(
  node: Estree,
  parent: Estree | undefined,
  lineAt: LineAt,
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
  const line = lineAt(node.start ?? 0);
  if (
    callee === "definePermissions" ||
    callee === "defineRoles" ||
    callee === "definePlans"
  ) {
    const name = declaredName(parent);
    if (name !== undefined) {
      if (callee === "definePermissions") {
        roots.add(name);
      }
      definitionFiles[name] = fileRel;
    }
    if (callee === "defineRoles") {
      collectObjectKeys(node.arguments?.[0], roleNames);
    }
    if (callee === "definePlans") {
      collectObjectKeys(node.arguments?.[0], planNames);
    }
    return;
  }
  if (callee === "role") {
    const first = node.arguments?.[0];
    if (typeof first?.value === "string") {
      roleNames.add(first.value);
    } else if (
      first?.type === "MemberExpression" &&
      typeof first.property?.name === "string"
    ) {
      roleNames.add(first.property.name);
    }
    return;
  }
  if (callee === "findPermission") {
    const second = node.arguments?.[1];
    if (typeof second?.value === "string") {
      pushUsage(
        second.value,
        { file: fileRel, line, call: "findPermission" },
        knownKeys,
        usages,
        unknown,
      );
      return;
    }
    dynamic.push({ file: fileRel, line, call: "findPermission" });
  }
}

function recordMember(
  node: Estree,
  parent: Estree | undefined,
  lineAt: LineAt,
  fileRel: string,
  isRoot: RootTest,
  usages: Record<string, CatalogUsage[]>,
  unknown: CatalogUsage[],
  dynamic: DynamicUsage[],
  allowKeys: Set<string>,
  knownKeys: ReadonlySet<string>,
): void {
  if (node.computed === true) {
    const root = rootName(node);
    if (root !== undefined && isRoot(root)) {
      dynamic.push({
        file: fileRel,
        line: lineAt(node.start ?? 0),
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
  if (root === undefined || !isRoot(root)) {
    return;
  }
  const key = rest.join(".");
  if (!knownKeys.has(key) && isFieldOrSubtree(rest, knownKeys)) {
    return;
  }
  const call = callName(parent);
  const usage = {
    file: fileRel,
    line: lineAt(node.start ?? 0),
    call,
  };
  if (call === "allow") {
    allowKeys.add(key);
  }
  pushUsage(key, usage, knownKeys, usages, unknown);
}

const LEAF_FIELDS: ReadonlySet<string> = new Set([
  "key",
  "resource",
  "action",
  "scope",
  "meta",
]);

function isFieldOrSubtree(
  path: readonly string[],
  knownKeys: ReadonlySet<string>,
): boolean {
  const last = path.at(-1);
  if (
    last !== undefined &&
    LEAF_FIELDS.has(last) &&
    knownKeys.has(path.slice(0, -1).join("."))
  ) {
    return true;
  }
  const prefix = `${path.join(".")}.`;
  return [...knownKeys].some((known) => known.startsWith(prefix));
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
  if (node.type === "Identifier") {
    return node.name;
  }
  if (
    node.type === "MemberExpression" &&
    node.property?.type === "Identifier"
  ) {
    return node.property.name;
  }
  return undefined;
}

function declaredName(parent: Estree | undefined): string | undefined {
  if (
    parent?.type === "VariableDeclarator" &&
    parent.id?.type === "Identifier"
  ) {
    return parent.id.name;
  }
  return undefined;
}

function callName(parent: Estree | undefined): string {
  if (parent?.type === "CallExpression") {
    const name = calleeName(parent.callee);
    if (name !== undefined && CHECK_CALLS.has(name)) {
      return name;
    }
  }
  if (parent?.type === "Property" || parent?.type === "ObjectProperty") {
    return "tools";
  }
  return "reference";
}

function memberPath(node: Estree): string[] | undefined {
  const parts: string[] = [];
  let current: Estree | undefined = node;
  while (current?.type === "MemberExpression") {
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
  if (current?.type !== "Identifier" || current.name === undefined) {
    return undefined;
  }
  parts.unshift(current.name);
  return parts;
}

function rootName(node: Estree): string | undefined {
  let current: Estree | undefined = node;
  while (current?.type === "MemberExpression") {
    current = current.object;
  }
  return current?.type === "Identifier" ? current.name : undefined;
}

type LineAt = (index: number) => number;

/** One pass over the file, then a binary search per node. */
function lineIndex(source: string): LineAt {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] ?? 0) <= index) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low + 1;
  };
}

function collectObjectKeys(node: Estree | undefined, into: Set<string>): void {
  if (node?.type !== "ObjectExpression" || node.properties === undefined) {
    return;
  }
  for (const property of node.properties) {
    const key = property.key;
    if (property.computed !== true && typeof key?.name === "string") {
      into.add(key.name);
      continue;
    }
    if (typeof key?.value === "string") {
      into.add(key.value);
    }
  }
}

/** Every node in source order, with its parent: Oxc nodes carry none, so enter and exit keep a stack. */
function walk(
  program: Program,
  visit: (
    node: Estree,
    parent: Estree | undefined,
    ancestors: readonly Estree[],
  ) => void,
): void {
  const stack: Estree[] = [];
  const handlers: Record<string, (node: Estree) => void> = {};
  for (const type of Object.keys(visitorKeys)) {
    handlers[type] = (node) => {
      visit(node, stack.at(-1), stack);
      stack.push(node);
    };
    handlers[`${type}:exit`] = () => {
      stack.pop();
    };
  }
  // SAFETY: one handler per type in visitorKeys; Estree is an all-optional view of every Oxc node.
  new Visitor(handlers as VisitorObject).visit(program);
}
