import {
  type VisitorObject,
  Visitor,
  parseSync,
  visitorKeys,
} from "oxc-parser";

import type { Rename, SignatureChange } from "./renames-0.5.ts";

/** One version's rename map: what the codemod rewrites and what it only reports. */
export type RenameSet = {
  readonly renames: readonly Rename[];
  readonly signatures: readonly SignatureChange[];
};

/** One rewritten span. */
export type CodemodChange = {
  readonly line: number;
  readonly column: number;
  readonly from: string;
  readonly to: string;
};

/** A site the codemod found and left alone because the change needs a person. */
export type CodemodFollowUp = {
  readonly line: number;
  readonly column: number;
  readonly name: string;
  readonly message: string;
};

export type TransformResult = {
  readonly source: string;
  readonly changes: readonly CodemodChange[];
  readonly followUps: readonly CodemodFollowUp[];
  /** Set when a script could not be parsed; the file is then left as it was. */
  readonly error?: string;
};

type Lang = "jsx" | "ts" | "tsx";

/** A parseable stretch of a file: the whole file, or one `<script>` block of a Vue or Svelte file. */
type Segment = {
  readonly code: string;
  readonly offset: number;
  readonly lang: Lang;
  /** Template markup can read an import, so a renamed import keeps its local name. */
  readonly keepLocals: boolean;
};

/** An all-optional view of an Oxc ESTree node; Oxc sets `start` and `end` on every node. */
type Estree = {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly name?: string;
  readonly value?: unknown;
  readonly object?: Estree;
  readonly property?: Estree;
  readonly computed?: boolean;
  readonly shorthand?: boolean;
  readonly callee?: Estree;
  readonly arguments?: readonly Estree[];
  readonly init?: Estree | null;
  readonly id?: Estree | null;
  readonly source?: Estree | null;
  readonly specifiers?: readonly Estree[];
  readonly local?: Estree;
  readonly imported?: Estree;
  readonly exported?: Estree;
  readonly declaration?: Estree | null;
  readonly declarations?: readonly Estree[];
  readonly body?: Estree | readonly Estree[];
  readonly properties?: readonly Estree[];
  readonly key?: Estree;
  readonly elements?: readonly (Estree | null)[];
  readonly params?: readonly Estree[];
  readonly param?: Estree | null;
  readonly parameter?: Estree;
  readonly left?: Estree;
  readonly right?: Estree;
  readonly argument?: Estree | null;
  readonly cases?: readonly Estree[];
  readonly consequent?: Estree | readonly Estree[];
  readonly typeParameters?: Estree | null;
};

type Edit = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

type Note = {
  readonly at: number;
  readonly name: string;
  readonly message: string;
};

/** A binding an `import { … } from 'permdock…'` declares at module level. */
type ImportBinding = {
  readonly entry: string;
  readonly imported: string;
  readonly spec: Estree;
  readonly rename: Rename | undefined;
};

type Reference = {
  readonly node: Estree;
  readonly place: "reference" | "shorthand" | "export";
  readonly parent: Estree;
};

type Context = {
  readonly program: Estree;
  readonly set: RenameSet;
  readonly edits: Edit[];
  readonly changes: {
    readonly at: number;
    readonly from: string;
    readonly to: string;
  }[];
  readonly followUps: Note[];
  readonly bindings: ReadonlyMap<string, ImportBinding>;
  readonly namespaces: ReadonlyMap<string, string>;
  readonly moduleNames: ReadonlySet<string>;
  /** Unaliased renamed imports, by local name. */
  readonly renamedLocals: ReadonlyMap<string, Rename>;
  /** Renamed imports that keep their local name through `to as from`. */
  readonly kept: Set<string>;
  readonly references: Reference[];
  readonly optionRows: readonly Rename[];
  readonly methodRows: readonly Rename[];
  readonly handledKeys: Set<Estree>;
  readonly scopes: WeakMap<Estree, ReadonlySet<string> | null>;
};

const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script>/gu;

function isPermDockSpecifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "permdock" || value.startsWith("permdock/"))
  );
}

/** Applies `set` to one file's source; `file` picks the parser by extension. */
export function transformSource(
  file: string,
  source: string,
  set: RenameSet,
): TransformResult {
  const lineAt = lineIndex(source);
  const edits: Edit[] = [];
  const changes: CodemodChange[] = [];
  const followUps: CodemodFollowUp[] = [];
  for (const segment of segmentsOf(file, source)) {
    const result = parseSync(`segment.${segment.lang}`, segment.code, {
      lang: segment.lang,
      sourceType: "module",
    });
    // `Severity` is an ambient const enum, which isolated modules cannot reference.
    const error = result.errors.find((item) => {
      const severity: string = item.severity;
      return severity === "Error";
    });
    if (error !== undefined) {
      return { source, changes: [], followUps: [], error: error.message };
    }
    // SAFETY: Estree is an all-optional view of the Oxc program, whose nodes all carry `start` and `end`.
    const ctx = contextFor(result.program as unknown as Estree, set);
    if (ctx === undefined) {
      continue;
    }
    transformProgram(ctx, segment);
    const at = (index: number) => position(lineAt, index + segment.offset);
    for (const item of ctx.edits) {
      edits.push({
        start: item.start + segment.offset,
        end: item.end + segment.offset,
        text: item.text,
      });
    }
    for (const change of ctx.changes) {
      changes.push({ ...at(change.at), from: change.from, to: change.to });
    }
    for (const note of ctx.followUps) {
      followUps.push({
        ...at(note.at),
        name: note.name,
        message: note.message,
      });
    }
  }
  return {
    source: applyEdits(source, edits),
    changes: changes.toSorted(byPosition),
    followUps: followUps.toSorted(byPosition),
  };
}

function byPosition(
  a: CodemodChange | CodemodFollowUp,
  b: CodemodChange | CodemodFollowUp,
): number {
  return a.line - b.line || a.column - b.column;
}

function segmentsOf(file: string, source: string): readonly Segment[] {
  const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "vue" || extension === "svelte") {
    return [...source.matchAll(SCRIPT_BLOCK)].map((match) => {
      const [whole, attributes = "", code = ""] = match;
      const typed = /\blang=["']?(?:ts|typescript)\b/u.test(attributes);
      return {
        code,
        offset: match.index + whole.indexOf(">") + 1,
        lang: typed ? "ts" : "jsx",
        keepLocals: true,
      };
    });
  }
  const lang: Lang =
    extension === "tsx"
      ? "tsx"
      : ["ts", "mts", "cts"].includes(extension)
        ? "ts"
        : "jsx";
  return [{ code: source, offset: 0, lang, keepLocals: false }];
}

/** The module's `permdock` imports, or `undefined` when it has none. */
function contextFor(program: Estree, set: RenameSet): Context | undefined {
  const bindings = new Map<string, ImportBinding>();
  const namespaces = new Map<string, string>();
  const entries = new Set<string>();
  for (const statement of nodes(program.body)) {
    const entry = statement.source?.value;
    if (!isPermDockSpecifier(entry)) {
      continue;
    }
    entries.add(entry);
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    for (const spec of nodes(statement.specifiers)) {
      const local = spec.local?.name ?? "";
      if (spec.type === "ImportNamespaceSpecifier") {
        namespaces.set(local, entry);
      }
      const imported = nameOf(spec.imported);
      if (spec.type === "ImportSpecifier" && imported !== undefined) {
        const rename = renameOf(set, imported, entry);
        bindings.set(local, { entry, imported, spec, rename });
      }
    }
  }
  if (entries.size === 0) {
    return undefined;
  }
  const renamedLocals = new Map<string, Rename>();
  for (const [local, binding] of bindings) {
    if (binding.rename !== undefined && local === binding.imported) {
      renamedLocals.set(local, binding.rename);
    }
  }
  const touches = (row: Rename): boolean =>
    row.entries.some((entry) => entries.has(entry));
  return {
    program,
    set,
    edits: [],
    changes: [],
    followUps: [],
    bindings,
    namespaces,
    moduleNames: scopeBindings(program) ?? new Set(),
    renamedLocals,
    kept: new Set(),
    references: [],
    optionRows: set.renames.filter(
      (row) => row.kind === "option" && touches(row),
    ),
    methodRows: set.renames.filter(
      (row) => row.kind === "method" && touches(row),
    ),
    handledKeys: new Set(),
    scopes: new WeakMap(),
  };
}

function transformProgram(ctx: Context, segment: Segment): void {
  for (const [local, rename] of ctx.renamedLocals) {
    if (segment.keepLocals || ctx.moduleNames.has(rename.to)) {
      ctx.kept.add(local);
    }
  }
  walk(ctx.program, (node, parent, ancestors) => {
    switch (node.type) {
      case "Identifier":
      case "JSXIdentifier":
        visitIdentifier(ctx, node, parent, ancestors);
        break;
      case "MemberExpression":
      case "TSQualifiedName":
        visitMember(ctx, node, ancestors);
        break;
      case "ObjectPattern":
        reportMethods(ctx, propertyKeys(node), "destructured", "comes from");
        break;
      case "CallExpression":
      case "NewExpression":
        visitCall(ctx, node, ancestors);
        break;
      case "ObjectExpression":
        reportOptions(ctx, node);
        break;
      default:
        break;
    }
  });
  rewriteImports(ctx);
  rewriteReferences(ctx);
  rewriteReexports(ctx);
  reportUncalledSignatures(ctx);
}

function declaredBetween(
  ctx: Context,
  name: string,
  ancestors: readonly Estree[],
): boolean {
  return ancestors.some(
    (scope) =>
      scope !== ctx.program &&
      bindingsCached(scope, ctx.scopes)?.has(name) === true,
  );
}

function isModuleBinding(
  ctx: Context,
  name: string,
  ancestors: readonly Estree[],
): boolean {
  return ctx.moduleNames.has(name) && !declaredBetween(ctx, name, ancestors);
}

function visitIdentifier(
  ctx: Context,
  node: Estree,
  parent: Estree | undefined,
  ancestors: readonly Estree[],
): void {
  const name = node.name ?? "";
  if (
    parent === undefined ||
    !(ctx.bindings.has(name) || ctx.namespaces.has(name))
  ) {
    return;
  }
  const place = referencePlace(node, parent, ancestors);
  if (place === "none" || !isModuleBinding(ctx, name, ancestors)) {
    return;
  }
  const rename = ctx.renamedLocals.get(name);
  if (rename !== undefined && declaredBetween(ctx, rename.to, ancestors)) {
    ctx.kept.add(name);
  }
  ctx.references.push({ node, place, parent });
}

function visitMember(
  ctx: Context,
  node: Estree,
  ancestors: readonly Estree[],
): void {
  const member = node.type === "MemberExpression";
  const object = member ? node.object : node.left;
  const property = member ? node.property : node.right;
  if (node.computed === true || property?.name === undefined) {
    return;
  }
  const namespace =
    object?.type === "Identifier" &&
    isModuleBinding(ctx, object.name ?? "", ancestors)
      ? ctx.namespaces.get(object.name ?? "")
      : undefined;
  const rename =
    namespace === undefined
      ? undefined
      : renameOf(ctx.set, property.name, namespace);
  if (rename !== undefined) {
    replace(ctx, property, rename.to, rename.from);
  } else if (member) {
    reportMethods(ctx, [property], "member", "is on a value from");
  }
}

function reportMethods(
  ctx: Context,
  keys: readonly Estree[],
  what: string,
  where: string,
): void {
  for (const key of keys) {
    for (const row of ctx.methodRows) {
      if (nameOf(key) === row.from) {
        ctx.followUps.push({
          at: key.start,
          name: row.from,
          message: `${what} \`${row.from}\` is \`${row.to}\` when it ${where} ${listOf(row.entries)}`,
        });
      }
    }
  }
}

/** The non-computed keys of an object literal or pattern. */
function propertyKeys(node: Estree): readonly Estree[] {
  return nodes(node.properties).flatMap((property) =>
    property.type === "Property" &&
    property.computed !== true &&
    property.key !== undefined
      ? [property.key]
      : [],
  );
}

function visitCall(
  ctx: Context,
  node: Estree,
  ancestors: readonly Estree[],
): void {
  const callee = importedCallee(ctx, node.callee, ancestors);
  if (callee === undefined) {
    return;
  }
  const renamed = renameOf(ctx.set, callee.imported, callee.entry)?.to;
  const names = new Set([callee.imported, renamed]);
  for (const signature of ctx.set.signatures) {
    if (signature.entries.includes(callee.entry) && names.has(signature.name)) {
      ctx.followUps.push({
        at: node.start,
        name: signature.name,
        message: `\`${signature.before}\` is now \`${signature.after}\``,
      });
    }
  }
  const rows = ctx.optionRows.filter(
    (row) =>
      row.entries.includes(callee.entry) &&
      (row.calls ?? []).some((call) => names.has(call)),
  );
  for (const argument of nodes(node.arguments)) {
    if (argument.type === "ObjectExpression") {
      renameOptions(ctx, argument, rows);
    }
  }
}

function renameOptions(
  ctx: Context,
  object: Estree,
  rows: readonly Rename[],
): void {
  for (const property of nodes(object.properties)) {
    const key = property.key;
    const row = rows.find((item) => item.from === nameOf(key));
    if (row === undefined || key === undefined || property.computed === true) {
      continue;
    }
    ctx.handledKeys.add(key);
    if (property.shorthand === true) {
      // An insertion before the value, so a renamed import in the value is rewritten on its own.
      edit(
        ctx,
        { ...property, end: property.start },
        `${row.to}: `,
        row.from,
        row.to,
      );
    } else {
      replace(
        ctx,
        key,
        key.type === "Literal" ? JSON.stringify(row.to) : row.to,
        row.from,
      );
    }
  }
}

/**
 * Rows with `calls` are renamed at those calls and nowhere else: their old
 * key (`store`) is still a valid option on every other factory.
 */
function reportOptions(ctx: Context, node: Estree): void {
  for (const key of propertyKeys(node)) {
    for (const row of ctx.optionRows) {
      if (
        row.calls === undefined &&
        nameOf(key) === row.from &&
        !ctx.handledKeys.has(key)
      ) {
        ctx.followUps.push({
          at: key.start,
          name: row.from,
          message: `option \`${row.from}\` is \`${row.to}\` when this object reaches ${listOf(row.entries)}`,
        });
      }
    }
  }
}

/** The import a call's callee is bound to: a named import, or a member of a namespace import. */
function importedCallee(
  ctx: Context,
  callee: Estree | undefined,
  ancestors: readonly Estree[],
): { readonly entry: string; readonly imported: string } | undefined {
  if (callee?.type === "Identifier") {
    const name = callee.name ?? "";
    return isModuleBinding(ctx, name, ancestors)
      ? ctx.bindings.get(name)
      : undefined;
  }
  const object =
    callee?.type === "MemberExpression" && callee.computed !== true
      ? callee.object
      : undefined;
  const namespace =
    object?.type === "Identifier" &&
    isModuleBinding(ctx, object.name ?? "", ancestors)
      ? ctx.namespaces.get(object.name ?? "")
      : undefined;
  const imported = callee?.property?.name;
  return namespace === undefined || imported === undefined
    ? undefined
    : { entry: namespace, imported };
}

function rewriteImports(ctx: Context): void {
  for (const [local, binding] of ctx.bindings) {
    const { rename, spec } = binding;
    const imported = spec.imported;
    if (rename === undefined || imported === undefined) {
      continue;
    }
    if (local !== binding.imported) {
      replace(
        ctx,
        imported,
        imported.type === "Literal" ? JSON.stringify(rename.to) : rename.to,
        rename.from,
      );
    } else {
      replace(
        ctx,
        imported,
        ctx.kept.has(local) ? `${rename.to} as ${local}` : rename.to,
        rename.from,
      );
    }
  }
}

function rewriteReferences(ctx: Context): void {
  for (const { node, place, parent } of ctx.references) {
    const name = node.name ?? "";
    const rename = ctx.renamedLocals.get(name);
    if (rename === undefined || ctx.kept.has(name)) {
      continue;
    }
    if (
      place === "shorthand" &&
      parent.key !== undefined &&
      ctx.handledKeys.has(parent.key)
    ) {
      replace(ctx, node, rename.to, name);
    } else if (place === "shorthand") {
      edit(ctx, parent, `${name}: ${rename.to}`, name, rename.to);
    } else if (place === "export" && parent.exported?.start === node.start) {
      replace(ctx, node, `${rename.to} as ${name}`, name);
    } else {
      replace(ctx, node, rename.to, name);
    }
  }
}

/** `export { a } from 'permdock'` keeps exporting `a`: the module's own export name is not the codemod's to change. */
function rewriteReexports(ctx: Context): void {
  for (const statement of nodes(ctx.program.body)) {
    const entry = statement.source?.value;
    if (
      statement.type !== "ExportNamedDeclaration" ||
      !isPermDockSpecifier(entry)
    ) {
      continue;
    }
    for (const spec of nodes(statement.specifiers)) {
      const local = spec.local;
      const rename = renameOf(ctx.set, nameOf(local) ?? "", entry);
      if (rename !== undefined && local !== undefined) {
        const same = spec.exported?.start === local.start;
        replace(
          ctx,
          local,
          same ? `${rename.to} as ${rename.from}` : rename.to,
          rename.from,
        );
      }
    }
  }
}

function reportUncalledSignatures(ctx: Context): void {
  for (const [local, binding] of ctx.bindings) {
    const names = new Set([binding.imported, binding.rename?.to]);
    for (const signature of ctx.set.signatures) {
      const imported =
        signature.entries.includes(binding.entry) && names.has(signature.name);
      if (
        imported &&
        !ctx.followUps.some((note) => note.name === signature.name)
      ) {
        ctx.followUps.push({
          at: binding.spec.start,
          name: signature.name,
          message: `\`${local}\` is imported; \`${signature.before}\` is now \`${signature.after}\``,
        });
      }
    }
  }
}

function edit(
  ctx: Context,
  node: Estree,
  text: string,
  from: string,
  to: string,
): void {
  if (
    ctx.edits.some((item) => item.start === node.start && item.end === node.end)
  ) {
    return;
  }
  ctx.edits.push({ start: node.start, end: node.end, text });
  ctx.changes.push({ at: node.start, from, to });
}

function replace(ctx: Context, node: Estree, text: string, from: string): void {
  edit(ctx, node, text, from, text.split(" as ")[0] ?? text);
}

function renameOf(
  set: RenameSet,
  name: string,
  entry: string,
): Rename | undefined {
  return set.renames.find(
    (row) =>
      row.from === name &&
      row.kind !== "option" &&
      row.kind !== "method" &&
      row.entries.includes(entry),
  );
}

function listOf(items: readonly string[]): string {
  return new Intl.ListFormat("en-GB", { type: "disjunction" }).format(items);
}

function nameOf(node: Estree | null | undefined): string | undefined {
  if (node?.type === "Literal") {
    return typeof node.value === "string" ? node.value : undefined;
  }
  return node?.name;
}

const NOT_REFERENCES: ReadonlySet<string> = new Set([
  "ImportSpecifier",
  "ImportDefaultSpecifier",
  "ImportNamespaceSpecifier",
  "LabeledStatement",
  "BreakStatement",
  "ContinueStatement",
  "TSEnumMember",
  "TSModuleDeclaration",
  "TSTypeParameter",
]);

const KEYED_MEMBERS: ReadonlySet<string> = new Set([
  "MethodDefinition",
  "PropertyDefinition",
  "AccessorProperty",
  "TSPropertySignature",
  "TSMethodSignature",
  "TSAbstractMethodDefinition",
  "TSAbstractPropertyDefinition",
]);

/** How an identifier is read: a plain reference, a shorthand property value, the local of an `export { }`, or not a reference. */
function referencePlace(
  node: Estree,
  parent: Estree,
  ancestors: readonly Estree[],
): "reference" | "shorthand" | "export" | "none" {
  const type = parent.type;
  if (node.type === "JSXIdentifier") {
    const element =
      type === "JSXOpeningElement" || type === "JSXClosingElement";
    return element || (type === "JSXMemberExpression" && parent.object === node)
      ? "reference"
      : "none";
  }
  if (type === "Property") {
    if (ancestors.at(-2)?.type === "ObjectPattern") {
      return "none";
    }
    if (parent.shorthand === true) {
      return parent.value === node ? "shorthand" : "none";
    }
    return parent.key === node && parent.computed !== true
      ? "none"
      : "reference";
  }
  if (type === "MemberExpression" || KEYED_MEMBERS.has(type)) {
    const named = type === "MemberExpression" ? parent.property : parent.key;
    return named === node && parent.computed !== true ? "none" : "reference";
  }
  if (type === "ExportSpecifier") {
    const reexport = ancestors.at(-2)?.source !== null;
    return parent.local === node && !reexport ? "export" : "none";
  }
  if (type === "TSQualifiedName") {
    return parent.right === node ? "none" : "reference";
  }
  return NOT_REFERENCES.has(type) ? "none" : "reference";
}

function nodes(value: unknown): readonly Estree[] {
  return Array.isArray(value) ? value.filter(isNode) : [];
}

function isNode(value: unknown): value is Estree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A child node under a field `Estree` types as something else (`value`, a type parameter's `name`). */
function child(node: Estree, field: string): Estree | undefined {
  const value: unknown = Reflect.get(node, field);
  return isNode(value) ? value : undefined;
}

function patternNames(
  pattern: Estree | null | undefined,
  into: Set<string>,
): void {
  if (pattern === null || pattern === undefined) {
    return;
  }
  switch (pattern.type) {
    case "Identifier":
      into.add(pattern.name ?? "");
      return;
    case "ObjectPattern":
      for (const property of nodes(pattern.properties)) {
        patternNames(
          property.type === "RestElement"
            ? property.argument
            : child(property, "value"),
          into,
        );
      }
      return;
    case "ArrayPattern":
      for (const element of nodes(pattern.elements)) {
        patternNames(element, into);
      }
      return;
    default:
      patternNames(pattern.left ?? pattern.argument ?? pattern.parameter, into);
  }
}

const DECLARATIONS_WITH_ID: ReadonlySet<string> = new Set([
  "FunctionDeclaration",
  "ClassDeclaration",
  "TSEnumDeclaration",
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSModuleDeclaration",
  "TSImportEqualsDeclaration",
  "TSDeclareFunction",
]);

function declareStatement(statement: Estree, into: Set<string>): void {
  const type = statement.type;
  if (type === "VariableDeclaration") {
    for (const declarator of nodes(statement.declarations)) {
      patternNames(declarator.id, into);
    }
  } else if (DECLARATIONS_WITH_ID.has(type)) {
    patternNames(statement.id, into);
  } else if (
    statement.declaration !== null &&
    statement.declaration !== undefined
  ) {
    declareStatement(statement.declaration, into);
  } else if (type === "ImportDeclaration") {
    for (const spec of nodes(statement.specifiers)) {
      patternNames(spec.local, into);
    }
  }
}

const BLOCK_SCOPES: ReadonlySet<string> = new Set([
  "Program",
  "BlockStatement",
  "StaticBlock",
  "TSModuleBlock",
]);

const FUNCTION_SCOPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "TSDeclareFunction",
]);

/** The names a node declares for the code inside it; `undefined` for a node that opens no scope. */
function scopeBindings(node: Estree): Set<string> | undefined {
  const names = new Set<string>();
  const declare = (
    statements: readonly (Estree | null | undefined)[],
  ): void => {
    for (const statement of statements) {
      if (statement !== null && statement !== undefined) {
        declareStatement(statement, names);
      }
    }
  };
  const type = node.type;
  let opens = true;
  if (BLOCK_SCOPES.has(type)) {
    declare(nodes(node.body));
  } else if (FUNCTION_SCOPES.has(type)) {
    for (const param of nodes(node.params)) {
      patternNames(param, names);
    }
    patternNames(type === "FunctionExpression" ? node.id : undefined, names);
  } else if (type === "ClassExpression") {
    patternNames(node.id, names);
  } else if (type === "ForStatement") {
    declare([node.init]);
  } else if (type === "ForInStatement" || type === "ForOfStatement") {
    declare([node.left]);
  } else if (type === "CatchClause") {
    patternNames(node.param, names);
  } else if (type === "SwitchStatement") {
    declare(nodes(node.cases).flatMap((branch) => nodes(branch.consequent)));
  } else if (type === "TSMappedType") {
    patternNames(node.key, names);
  } else {
    opens = false;
  }
  for (const param of nodes(node.typeParameters?.params)) {
    opens = true;
    patternNames(child(param, "name"), names);
  }
  return opens ? names : undefined;
}

function bindingsCached(
  node: Estree,
  cache: WeakMap<Estree, ReadonlySet<string> | null>,
): ReadonlySet<string> | null {
  let found = cache.get(node);
  if (found === undefined) {
    found = scopeBindings(node) ?? null;
    cache.set(node, found);
  }
  return found;
}

function applyEdits(source: string, edits: readonly Edit[]): string {
  let out = source;
  // At one start, the replacement goes in before the insertion that precedes it.
  for (const item of edits.toSorted(
    (a, b) => b.start - a.start || b.end - a.end,
  )) {
    out = out.slice(0, item.start) + item.text + out.slice(item.end);
  }
  return out;
}

type LineAt = (index: number) => {
  readonly line: number;
  readonly lineStart: number;
};

function position(
  lineAt: LineAt,
  index: number,
): { readonly line: number; readonly column: number } {
  const { line, lineStart } = lineAt(index);
  return { line, column: index - lineStart + 1 };
}

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
    return { line: low + 1, lineStart: starts[low] ?? 0 };
  };
}

/** Every node in source order with its parent and ancestors: Oxc nodes carry no parent, so enter and exit keep a stack. */
function walk(
  program: Estree,
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
  // SAFETY: one handler per type in visitorKeys; Estree is an all-optional view of every Oxc node, and `program` is the parse result.
  new Visitor(handlers as VisitorObject).visit(program as never);
}
