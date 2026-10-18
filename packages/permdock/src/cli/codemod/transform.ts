import { parseSync } from "oxc-parser";

import type { Rename } from "./renames-0.5.ts";

import {
  type Edit,
  type Estree,
  applyEdits,
  lineIndex,
  nameOf,
  nodes,
  position,
  referencePlace,
  scopeBindings,
  walk,
} from "./ast.ts";
import {
  type CodemodChange,
  type CodemodFollowUp,
  type Context,
  type ImportBinding,
  type RenameSet,
  SCRIPT_BLOCK,
  declaredBetween,
  edit,
  importedCallee,
  isModuleBinding,
  isPermDockSpecifier,
  listOf,
  renameKey,
  renameOf,
  replace,
} from "./context.ts";
import { finishImports, removableBindings } from "./imports.ts";
import {
  awaitRow,
  holdsInstance,
  reportUnawaited,
  templateHints,
  visitAwait,
  visitComponentArguments,
  visitElement,
  visitFunctionCall,
  visitMethodCall,
  visitWraps,
  reportWraps,
  visitDurations,
} from "./shapes.ts";

export type { CodemodChange, CodemodFollowUp, RenameSet } from "./context.ts";

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
  const components = new Set<string>();
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
    const ctx = contextFor(
      // SAFETY: Estree is an all-optional view of the Oxc program, whose nodes all carry `start` and `end`.
      result.program as unknown as Estree,
      set,
      segment,
    );
    if (ctx === undefined) {
      continue;
    }
    transformProgram(ctx, segment);
    for (const binding of ctx.bindings.values()) {
      components.add(`${binding.entry} ${binding.imported}`);
    }
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
  followUps.push(...templateHints(file, source, set, components, lineAt));
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
function contextFor(
  program: Estree,
  set: RenameSet,
  segment: Segment,
): Context | undefined {
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
        bindings.set(local, {
          entry,
          imported,
          spec,
          declaration: statement,
          rename,
        });
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
    code: segment.code,
    keepLocals: segment.keepLocals,
    consumed: new Set(),
    additions: new Map(),
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
    factories: factoryValues(program, bindings),
    handledKeys: new Set(),
    newShapes: new Set(),
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
        visitComponentArguments(ctx, node, ancestors);
        visitMethodCall(ctx, node, ancestors);
        break;
      case "JSXOpeningElement":
        visitElement(ctx, node, ancestors);
        break;
      case "AwaitExpression":
        visitAwait(ctx, node, ancestors);
        break;
      case "ObjectExpression":
        reportOptions(ctx, node, ancestors);
        reportWraps(ctx, node, ancestors);
        visitDurations(ctx, node, ancestors);
        break;
      default:
        break;
    }
  });
  const removed = removableBindings(ctx);
  rewriteImports(ctx, removed);
  rewriteReferences(ctx);
  rewriteReexports(ctx);
  reportUncalledSignatures(ctx, removed);
  finishImports(ctx, removed);
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
    const receiver = object?.type === "Identifier" ? object.name : undefined;
    const origin =
      receiver !== undefined && isModuleBinding(ctx, receiver, ancestors)
        ? ctx.factories.get(receiver)
        : undefined;
    const method =
      origin === undefined
        ? undefined
        : ctx.methodRows.find(
            (row) => row.from === property.name && row.entries.includes(origin),
          );
    if (method !== undefined) {
      replace(ctx, property, method.to, method.from);
    } else if (origin === undefined) {
      reportMethods(ctx, [property], "member", "is on a value from");
    }
  }
}

/** `const x = f(…)` or `const x = await f(…)` at module level, where `f` is imported from a permdock entry. */
function factoryValues(
  program: Estree,
  bindings: ReadonlyMap<string, ImportBinding>,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const statement of nodes(program.body)) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (
      declaration?.type !== "VariableDeclaration" ||
      Reflect.get(declaration, "kind") !== "const"
    ) {
      continue;
    }
    for (const declarator of nodes(declaration.declarations)) {
      const init =
        declarator.init?.type === "AwaitExpression"
          ? declarator.init.argument
          : declarator.init;
      const callee = init?.type === "CallExpression" ? init.callee : undefined;
      const factory = callee?.type === "Identifier" ? callee.name : undefined;
      const entry =
        factory === undefined ? undefined : bindings.get(factory)?.entry;
      const name =
        declarator.id?.type === "Identifier" ? declarator.id.name : undefined;
      if (entry !== undefined && name !== undefined) {
        out.set(name, entry);
      }
    }
  }
  return out;
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
  const pending = awaitRow(ctx, callee);
  if (pending !== undefined && ancestors.at(-1)?.type !== "AwaitExpression") {
    reportUnawaited(ctx, node, ancestors, pending);
  }
  const renamed = renameOf(ctx.set, callee.imported, callee.entry)?.to;
  const names = new Set([callee.imported, renamed]);
  const moved = visitFunctionCall(ctx, node, callee);
  visitWraps(ctx, node, callee, ancestors);
  for (const signature of ctx.set.signatures) {
    if (
      !moved &&
      signature.entries.includes(callee.entry) &&
      names.has(signature.name)
    ) {
      if (signature.shape === "curried" && !isCurried(node, ancestors)) {
        ctx.newShapes.add(signature.name);
        continue;
      }
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

/** `f(options)(key)`, or `f({ … })` whose result is kept for a later call. */
function isCurried(node: Estree, ancestors: readonly Estree[]): boolean {
  const args = nodes(node.arguments);
  const parent = ancestors.at(-1);
  return (
    args.length === 1 &&
    (args[0]?.type === "ObjectExpression" ||
      (parent?.type === "CallExpression" && parent.callee === node))
  );
}

function renameOptions(
  ctx: Context,
  object: Estree,
  rows: readonly Rename[],
): void {
  for (const property of nodes(object.properties)) {
    const row = rows.find((item) => item.from === nameOf(property.key));
    if (row !== undefined) {
      renameKey(ctx, property, row.from, row.to);
    }
  }
}

/**
 * Rows with `calls` are renamed at those calls and nowhere else: their old
 * key (`store`) is still a valid option on every other factory. Rows without
 * `calls` are reported only on an object that reaches a permdock call.
 */
function reportOptions(
  ctx: Context,
  node: Estree,
  ancestors: readonly Estree[],
): void {
  const target = optionTarget(ctx, node, ancestors);
  if (target === undefined) {
    return;
  }
  const rows = ctx.optionRows.filter(
    (row) =>
      row.calls === undefined &&
      (target.entry === undefined || row.entries.includes(target.entry)),
  );
  for (const key of propertyKeys(node)) {
    for (const row of rows) {
      if (nameOf(key) === row.from && !ctx.handledKeys.has(key)) {
        ctx.followUps.push({
          at: key.start,
          name: row.from,
          message: `option \`${row.from}\` is \`${row.to}\` when this object reaches ${listOf(row.entries)}`,
        });
      }
    }
  }
}

const PASS_THROUGH = new Set([
  "ArrayExpression",
  "ObjectExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
]);

/**
 * The permdock call an object literal is an argument of, directly or nested
 * in another argument's object, array or property value. `entry` is unset
 * for a method on a receiver named after PermDock, whose entry is unknown.
 */
function optionTarget(
  ctx: Context,
  node: Estree,
  ancestors: readonly Estree[],
): { readonly entry: string | undefined } | undefined {
  let child = node;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const parent = ancestors[index];
    if (parent === undefined) {
      return undefined;
    }
    if (parent.type === "CallExpression" || parent.type === "NewExpression") {
      return nodes(parent.arguments).includes(child)
        ? calleeTarget(ctx, parent.callee, ancestors)
        : undefined;
    }
    const passes =
      (parent.type === "Property" && parent.value === child) ||
      PASS_THROUGH.has(parent.type);
    if (!passes) {
      return undefined;
    }
    child = parent;
  }
  return undefined;
}

function calleeTarget(
  ctx: Context,
  callee: Estree | undefined,
  ancestors: readonly Estree[],
): { readonly entry: string | undefined } | undefined {
  const imported = importedCallee(ctx, callee, ancestors);
  if (imported !== undefined) {
    return { entry: imported.entry };
  }
  const receiver =
    callee?.type === "MemberExpression" && callee.computed !== true
      ? callee.object
      : undefined;
  if (!holdsInstance(ctx, receiver, ancestors)) {
    return undefined;
  }
  const name = receiver?.name ?? "";
  return {
    entry: isModuleBinding(ctx, name, ancestors)
      ? ctx.factories.get(name)
      : undefined,
  };
}

function rewriteImports(ctx: Context, removed: ReadonlySet<string>): void {
  for (const [local, binding] of ctx.bindings) {
    const { rename, spec } = binding;
    const imported = spec.imported;
    if (rename === undefined || imported === undefined || removed.has(local)) {
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
    if (
      rename === undefined ||
      ctx.kept.has(name) ||
      ctx.consumed.has(node.start)
    ) {
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

function reportUncalledSignatures(
  ctx: Context,
  removed: ReadonlySet<string>,
): void {
  for (const [local, binding] of ctx.bindings) {
    if (removed.has(local)) {
      continue;
    }
    const names = new Set([binding.imported, binding.rename?.to]);
    for (const signature of ctx.set.signatures) {
      const imported =
        signature.entries.includes(binding.entry) && names.has(signature.name);
      if (
        imported &&
        !ctx.newShapes.has(signature.name) &&
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
