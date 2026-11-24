import type { Edit, Estree } from "./ast.ts";

import { parseSync } from "../core/optional.ts";
import { applyEdits, child, nameOf, nodes, walk } from "./ast.ts";

const WRAPPERS: ReadonlySet<string> = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "ParenthesizedExpression",
]);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

/** The program, or `undefined` when the file does not parse. */
function parse(file: string, source: string): Estree | undefined {
  const lang = file.endsWith(".tsx")
    ? "tsx"
    : /\.[cm]?ts$/u.test(file)
      ? "ts"
      : "js";
  const parsed = parseSync(file, source, { lang, sourceType: "module" });
  if (parsed.errors.length > 0) return undefined;
  // SAFETY: Estree is an all-optional view of every Oxc node, and `program` is the parse result.
  return parsed.program as unknown as Estree;
}

function unwrap(node: Estree | undefined): Estree | undefined {
  return node !== undefined && WRAPPERS.has(node.type)
    ? unwrap(child(node, "expression"))
    : node;
}

function propertyName(property: Estree): string | undefined {
  return property.type === "Property" && property.computed !== true
    ? nameOf(property.key)
    : undefined;
}

function propertyOf(
  object: Estree | undefined,
  name: string,
): Estree | undefined {
  return nodes(object?.properties).find(
    (property) => propertyName(property) === name,
  );
}

function valueOf(property: Estree | undefined): Estree | undefined {
  return property === undefined ? undefined : unwrap(child(property, "value"));
}

function stringValue(node: Estree | undefined): string | undefined {
  return node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;
}

/**
 * The edits that remove `removed` from `siblings`: each run of adjacent removed
 * entries goes with the separator after it, or before it when it ends the
 * list.
 */
function removals(
  source: string,
  siblings: readonly Estree[],
  removed: ReadonlySet<Estree>,
): readonly Edit[] {
  const runs: { first: Estree; last: Estree }[] = [];
  let current: { first: Estree; last: Estree } | undefined;
  for (const node of siblings) {
    if (removed.has(node)) {
      if (current === undefined) {
        current = { first: node, last: node };
        runs.push(current);
      } else {
        current.last = node;
      }
    } else {
      current = undefined;
    }
  }
  return runs.map(({ first, last }) => {
    const next = siblings[siblings.indexOf(last) + 1];
    const previous = siblings[siblings.indexOf(first) - 1];
    if (next !== undefined) {
      return { start: first.start, end: next.start, text: "" };
    }
    if (previous !== undefined) {
      return { start: previous.end, end: last.end, text: "" };
    }
    const comma = /^\s*,/u.exec(source.slice(last.end));
    return {
      start: first.start,
      end: last.end + (comma?.[0].length ?? 0),
      text: "",
    };
  });
}

/** A string key a `blocks` entry's `permissions` names for one action. */
export type ConfigKey = {
  readonly instance: string;
  readonly action: string;
  readonly key: string;
};

/**
 * Removes each `permissions: { <action>: '<key>' }` entry of a `blocks` list
 * entry for which `wanted` answers true, and a `permissions` object that ends
 * up empty. Options nested inside an entry (`on.<x>.permissions`) stay.
 */
export function removeConfigKeys(
  file: string,
  source: string,
  wanted: (entry: ConfigKey) => boolean,
): { readonly source: string; readonly removed: readonly ConfigKey[] } {
  const program = parse(file, source);
  if (program === undefined) return { source, removed: [] };
  const edits: Edit[] = [];
  const removed: ConfigKey[] = [];
  walk(program, (node) => {
    if (propertyName(node) !== "blocks") return;
    const list = valueOf(node);
    if (list?.type !== "ArrayExpression") return;
    for (const element of nodes(list.elements)) {
      const entry = unwrap(element);
      if (entry?.type !== "ObjectExpression") continue;
      const block = stringValue(valueOf(propertyOf(entry, "block")));
      if (block === undefined) continue;
      const instance = stringValue(valueOf(propertyOf(entry, "name"))) ?? block;
      const holder = propertyOf(entry, "permissions");
      const permissions = valueOf(holder);
      if (holder === undefined || permissions?.type !== "ObjectExpression")
        continue;
      const drop = new Set<Estree>();
      for (const property of nodes(permissions.properties)) {
        const action = propertyName(property);
        const key = stringValue(child(property, "value"));
        if (action === undefined || key === undefined) continue;
        const found = { instance, action, key };
        if (wanted(found)) {
          drop.add(property);
          removed.push(found);
        }
      }
      const siblings = nodes(permissions.properties);
      if (drop.size === 0) continue;
      edits.push(
        ...(drop.size === siblings.length
          ? removals(source, nodes(entry.properties), new Set([holder]))
          : removals(source, siblings, drop)),
      );
    }
  });
  return { source: applyEdits(source, edits), removed };
}

type ActionSite =
  | { readonly kind: "record"; readonly property: Estree }
  | { readonly kind: "array"; readonly list: Estree };

function topLevelConstants(program: Estree): ReadonlyMap<string, Estree> {
  const found = new Map<string, Estree>();
  for (const statement of nodes(program.body)) {
    const declaration =
      statement.type === "VariableDeclaration"
        ? statement
        : (statement.declaration ?? undefined);
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of nodes(declaration.declarations)) {
      const name =
        declarator.id?.type === "Identifier" ? declarator.id.name : undefined;
      if (
        name !== undefined &&
        declarator.init !== null &&
        declarator.init !== undefined
      ) {
        found.set(name, declarator.init);
      }
    }
  }
  return found;
}

function definePermissionsRoot(program: Estree): Estree | undefined {
  let root: Estree | undefined;
  walk(program, (node) => {
    if (
      root === undefined &&
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "definePermissions"
    ) {
      root = nodes(node.arguments)[0];
    }
  });
  return root;
}

/** `action` in a `resource()` options object's `actions` or `collection`. */
function actionIn(
  options: Estree | undefined,
  action: string,
  resolveNode: (node: Estree | undefined) => Estree | undefined,
): ActionSite | undefined {
  for (const field of ["actions", "collection"]) {
    const list = resolveNode(valueOf(propertyOf(options, field)));
    const property =
      list?.type === "ObjectExpression" ? propertyOf(list, action) : undefined;
    if (property !== undefined) {
      return { kind: "record", property };
    }
    if (
      list?.type === "ArrayExpression" &&
      nodes(list.elements).some((element) => stringValue(element) === action)
    ) {
      return { kind: "array", list };
    }
  }
  return undefined;
}

/**
 * Where `key` declares its action: a property of a `resource()` call's
 * `actions` or `collection` record, or the array that lists it. The path walks
 * object literals, top-level constants and `resource()` calls only.
 */
function actionSite(
  start: Estree | undefined,
  key: string,
  constants: ReadonlyMap<string, Estree>,
): ActionSite | undefined {
  const resolveNode = (node: Estree | undefined): Estree | undefined => {
    const bare = unwrap(node);
    return bare?.type === "Identifier" && bare.name !== undefined
      ? unwrap(constants.get(bare.name))
      : bare;
  };
  const segments = key.split(".");
  let node = resolveNode(start);
  for (const [index, segment] of segments.entries()) {
    if (
      node?.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "resource"
    ) {
      return index === segments.length - 1
        ? actionIn(
            resolveNode(nodes(node.arguments).at(-1)),
            segment,
            resolveNode,
          )
        : undefined;
    }
    if (node?.type !== "ObjectExpression") return undefined;
    node = resolveNode(valueOf(propertyOf(node, segment)));
  }
  return undefined;
}

function quoted(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

function keyText(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** The edit that adds `answers` to one action's meta object. */
function recordEdit(
  source: string,
  property: Estree,
  answers: readonly string[],
): Edit | undefined {
  const meta = valueOf(property);
  if (meta?.type !== "ObjectExpression") return undefined;
  const existing = propertyOf(meta, "answers");
  if (existing !== undefined) {
    const list = valueOf(existing);
    if (list?.type !== "ArrayExpression") return undefined;
    const have = new Set(nodes(list.elements).map(stringValue));
    const add = answers.filter((answer) => !have.has(answer));
    if (add.length === 0) return { start: list.end, end: list.end, text: "" };
    const close = source.lastIndexOf("]", list.end);
    const items = nodes(list.elements);
    const trailing =
      items.length > 0 && /,\s*$/u.test(source.slice(items.at(-1)?.end, close));
    return {
      start: close,
      end: close,
      text:
        items.length === 0
          ? quoted(add)
          : `${trailing ? " " : ", "}${quoted(add)}`,
    };
  }
  if (nodes(meta.properties).length === 0) {
    return {
      start: meta.start,
      end: meta.end,
      text: `{ answers: [${quoted(answers)}] }`,
    };
  }
  return {
    start: meta.start + 1,
    end: meta.start + 1,
    text: ` answers: [${quoted(answers)}],`,
  };
}

/** The edit that turns an action array into a record carrying `answers`. */
function arrayEdit(
  list: Estree,
  answers: ReadonlyMap<string, readonly string[]>,
): Edit | undefined {
  const names = nodes(list.elements).map(stringValue);
  if (names.some((name) => name === undefined)) return undefined;
  const entries = names.map((name = "") => {
    const add = answers.get(name);
    return `${keyText(name)}: ${add === undefined ? "{}" : `{ answers: [${quoted(add)}] }`}`;
  });
  return {
    start: list.start,
    end: list.end,
    text: `{ ${entries.join(", ")} }`,
  };
}

/**
 * Adds each answer to the `answers` of the permission whose key maps to it, in
 * the `definePermissions` call of the module. `missing` lists the keys whose
 * action the module does not declare in a form the codemod edits.
 */
export function addAnswers(
  file: string,
  source: string,
  answers: ReadonlyMap<string, readonly string[]>,
): { readonly source: string; readonly missing: readonly string[] } {
  const program = parse(file, source);
  if (program === undefined) return { source, missing: [...answers.keys()] };
  const constants = topLevelConstants(program);
  const root = definePermissionsRoot(program);
  const missing: string[] = [];
  const edits: Edit[] = [];
  const arrays = new Map<Estree, Map<string, readonly string[]>>();
  const arrayKeys = new Map<Estree, string[]>();
  for (const [key, add] of answers) {
    const site = actionSite(root, key, constants);
    if (site?.kind === "array") {
      const action = key.split(".").at(-1) ?? "";
      const byAction =
        arrays.get(site.list) ?? new Map<string, readonly string[]>();
      byAction.set(action, add);
      arrays.set(site.list, byAction);
      arrayKeys.set(site.list, [...(arrayKeys.get(site.list) ?? []), key]);
      continue;
    }
    const edit =
      site === undefined ? undefined : recordEdit(source, site.property, add);
    if (edit === undefined) missing.push(key);
    else edits.push(edit);
  }
  for (const [list, byAction] of arrays) {
    const edit = arrayEdit(list, byAction);
    if (edit === undefined) missing.push(...(arrayKeys.get(list) ?? []));
    else edits.push(edit);
  }
  return { source: applyEdits(source, edits), missing };
}
