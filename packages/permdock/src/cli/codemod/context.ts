import type { Edit, Estree } from "./ast.ts";
import type { ConfigMove } from "./config-moves.ts";
import type { Rename, SignatureChange } from "./renames-0.5.ts";
import type {
  AwaitRename,
  DurationKeys,
  FunctionToMethod,
  MethodToFunction,
  OptionWrap,
  PropRename,
  TemplateHint,
} from "./shapes-0.5.ts";

import { beforeFirst } from "../shared/text.ts";
import { bindingsCached, nameOf, nodes } from "./ast.ts";

/** One version's rename map: what the codemod rewrites and what it only reports. */
export const SCRIPT_BLOCK: RegExp = /<script\b([^>]*)>([\s\S]*?)<\/script>/gu;

export type RenameSet = {
  readonly renames: readonly Rename[];
  readonly signatures: readonly SignatureChange[];
  readonly props?: readonly PropRename[];
  readonly templates?: readonly TemplateHint[];
  readonly awaits?: readonly AwaitRename[];
  readonly methodFunctions?: readonly MethodToFunction[];
  readonly functionMethods?: readonly FunctionToMethod[];
  readonly wraps?: readonly OptionWrap[];
  readonly durations?: DurationKeys;
  readonly configMoves?: readonly ConfigMove[];
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

export type Note = {
  readonly at: number;
  readonly name: string;
  readonly message: string;
};

/** A binding an `import { … } from 'permdock…'` declares at module level. */
export type ImportBinding = {
  readonly entry: string;
  readonly imported: string;
  readonly spec: Estree;
  readonly declaration: Estree;
  readonly rename: Rename | undefined;
};

export type Reference = {
  readonly node: Estree;
  readonly place: "reference" | "shorthand" | "export";
  readonly parent: Estree;
};

export type Context = {
  readonly program: Estree;
  readonly code: string;
  readonly keepLocals: boolean;
  readonly consumed: Set<number>;
  readonly additions: Map<string, Set<string>>;
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
  /**
   * Module-level constants holding a factory result, to the entry the factory
   * came from.
   */
  readonly factories: ReadonlyMap<string, string>;
  readonly handledKeys: Set<Estree>;
  /**
   * Signature changes called in their new shape, so the import is not reported
   * as uncalled.
   */
  readonly newShapes: Set<string>;
  readonly scopes: WeakMap<Estree, ReadonlySet<string> | null>;
};

export function isPermDockSpecifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "permdock" || value.startsWith("permdock/"))
  );
}

export function declaredBetween(
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

export function isModuleBinding(
  ctx: Context,
  name: string,
  ancestors: readonly Estree[],
): boolean {
  return ctx.moduleNames.has(name) && !declaredBetween(ctx, name, ancestors);
}

export function edit(
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

export function replace(
  ctx: Context,
  node: Estree,
  text: string,
  from: string,
): void {
  edit(ctx, node, text, from, beforeFirst(text, " as "));
}

export function renameOf(
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

export function listOf(items: readonly string[]): string {
  return new Intl.ListFormat("en-GB", { type: "disjunction" }).format(items);
}

/**
 * The import a call's callee is bound to: a named import, or a member of a
 * namespace import.
 */
export function importedCallee(
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

export function renameKey(
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

export function renameKeys(
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

export function boundImport(
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
