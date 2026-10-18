import { parseSync } from "oxc-parser";

import type { Rename, SignatureChange } from "./renames-0.5.ts";
import type { PropRename, TemplateHint } from "./shapes-0.5.ts";

import {
  type Edit,
  type Estree,
  applyEdits,
  bindingsCached,
  child,
  lineIndex,
  nameOf,
  nodes,
  position,
  referencePlace,
  scopeBindings,
  walk,
} from "./ast.ts";

/** One version's rename map: what the codemod rewrites and what it only reports. */
export type RenameSet = {
  readonly renames: readonly Rename[];
  readonly signatures: readonly SignatureChange[];
  readonly props?: readonly PropRename[];
  readonly templates?: readonly TemplateHint[];
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
  /** Module-level constants holding a factory result, to the entry the factory came from. */
  readonly factories: ReadonlyMap<string, string>;
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
    // SAFETY: Estree is an all-optional view of the Oxc program, whose nodes all carry `start` and `end`.
    const ctx = contextFor(result.program as unknown as Estree, set);
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

function templateHints(
  file: string,
  source: string,
  set: RenameSet,
  components: ReadonlySet<string>,
  lineAt: ReturnType<typeof lineIndex>,
): readonly CodemodFollowUp[] {
  const hints = (set.templates ?? []).filter((hint) =>
    hint.entries.some((entry) => components.has(`${entry} ${hint.component}`)),
  );
  if (hints.length === 0 || !/\.(?:vue|svelte)$/iu.test(file)) {
    return [];
  }
  const markup = source.replaceAll(SCRIPT_BLOCK, (block) =>
    " ".repeat(block.length),
  );
  return hints.flatMap((hint) =>
    [...markup.matchAll(hint.pattern)].map((match) => {
      const { line, column } = position(lineAt, match.index);
      return { line, column, name: hint.name, message: hint.message };
    }),
  );
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
    factories: factoryValues(program, bindings),
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
        visitComponentArguments(ctx, node, ancestors);
        break;
      case "JSXOpeningElement":
        visitElement(ctx, node, ancestors);
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
    const row = rows.find((item) => item.from === nameOf(property.key));
    if (row !== undefined) {
      renameKey(ctx, property, row.from, row.to);
    }
  }
}

function renameKeys(
  ctx: Context,
  object: Estree,
  from: string,
  to: string,
): void {
  for (const property of nodes(object.properties)) {
    if (nameOf(property.key) === from) {
      renameKey(ctx, property, from, to);
    }
  }
}

function renameKey(
  ctx: Context,
  property: Estree,
  from: string,
  to: string,
): void {
  const key = property.key;
  if (
    property.type !== "Property" ||
    key === undefined ||
    property.computed === true
  ) {
    return;
  }
  ctx.handledKeys.add(key);
  if (property.shorthand === true) {
    // An insertion before the value, so a renamed import in the value is rewritten on its own.
    edit(ctx, { ...property, end: property.start }, `${to}: `, from, to);
  } else {
    replace(ctx, key, key.type === "Literal" ? JSON.stringify(to) : to, from);
  }
}

function boundImport(
  ctx: Context,
  node: Estree | undefined,
  ancestors: readonly Estree[],
): ImportBinding | undefined {
  const name = node?.name;
  return (node?.type === "Identifier" || node?.type === "JSXIdentifier") &&
    name !== undefined &&
    isModuleBinding(ctx, name, ancestors)
    ? ctx.bindings.get(name)
    : undefined;
}

function propRows(
  ctx: Context,
  binding: ImportBinding | undefined,
): readonly PropRename[] {
  return binding === undefined
    ? []
    : (ctx.set.props ?? []).filter(
        (row) =>
          row.component === binding.imported &&
          row.entries.includes(binding.entry),
      );
}

function visitElement(
  ctx: Context,
  node: Estree,
  ancestors: readonly Estree[],
): void {
  const tag = child(node, "name");
  const binding = boundImport(ctx, tag, ancestors);
  const rows = propRows(ctx, binding);
  const named =
    tag?.type === "JSXMemberExpression" ? child(tag, "property") : tag;
  const unbound = (ctx.set.props ?? []).filter(
    (row) =>
      binding === undefined &&
      row.within !== undefined &&
      named?.type === "JSXIdentifier" &&
      named.name === row.component,
  );
  for (const attribute of nodes(Reflect.get(node, "attributes"))) {
    const name = child(attribute, "name");
    if (attribute.type !== "JSXAttribute" || name?.type !== "JSXIdentifier") {
      continue;
    }
    for (const row of rows) {
      if (row.within === undefined && name.name === row.from) {
        replace(ctx, name, row.to, row.from);
      } else if (row.within !== undefined && name.name === row.within) {
        renameWithin(ctx, attribute, row);
      }
    }
    for (const row of unbound) {
      if (name.name === row.within && holdsKey(attribute, row.from)) {
        ctx.followUps.push({
          at: attribute.start,
          name: row.from,
          message: `\`${row.within}.${row.from}\` of \`<${row.component}>\` is \`${row.within}.${row.to}\``,
        });
      }
    }
  }
}

function attributeObject(attribute: Estree): Estree | undefined {
  const value = child(attribute, "value");
  const expression =
    value?.type === "JSXExpressionContainer"
      ? child(value, "expression")
      : undefined;
  return expression?.type === "ObjectExpression" ? expression : undefined;
}

function holdsKey(attribute: Estree, key: string): boolean {
  const object = attributeObject(attribute);
  return (
    object === undefined ||
    nodes(object.properties).some((property) => nameOf(property.key) === key)
  );
}

function renameWithin(ctx: Context, attribute: Estree, row: PropRename): void {
  const object = attributeObject(attribute);
  if (object === undefined) {
    ctx.followUps.push({
      at: attribute.start,
      name: row.from,
      message: `\`${row.within}.${row.from}\` of \`<${row.component}>\` is \`${row.within}.${row.to}\``,
    });
    return;
  }
  renameKeys(ctx, object, row.from, row.to);
}

function visitComponentArguments(
  ctx: Context,
  node: Estree,
  ancestors: readonly Estree[],
): void {
  const args = nodes(node.arguments);
  for (const [index, argument] of args.entries()) {
    const rows = propRows(ctx, boundImport(ctx, argument, ancestors)).filter(
      (row) => row.within === undefined,
    );
    for (const row of rows) {
      for (const later of args.slice(index + 1)) {
        if (later.type === "ObjectExpression") {
          renameKeys(ctx, later, row.from, row.to);
        }
      }
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
