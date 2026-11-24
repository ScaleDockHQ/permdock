import type { Edit, Estree } from "../codemod/ast.ts";

import { child, nameOf, nodes, walk } from "../codemod/ast.ts";
import { configError } from "../core/errors.ts";
import {
  applyEditsStrict,
  propertyKey,
  removeProperty,
} from "../source/edits.ts";
import { parseProgram } from "../source/program.ts";
import { appendItem, removeElement } from "./tree-edits.ts";

type ListKind = "actions" | "collection";

/** A resource's `actions` or `collection` literal and one action in it. */
type ActionSite = {
  readonly kind: ListKind;
  readonly list: Estree;
  /** The string element of an array, or the property of a record. */
  readonly item: Estree | undefined;
};

type ResourceSite = {
  /** The object literal holding the resource's property. */
  readonly container: Estree;
  readonly property: Estree;
  /** The `resource()` options object. */
  readonly options: Estree;
};

export type TreeRename = {
  readonly text: string;
  /** What the rewrite did beyond moving the key, for the report. */
  readonly notes: readonly string[];
};

const WRAPPERS: ReadonlySet<string> = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "ParenthesizedExpression",
]);

function quote(value: string): string {
  return JSON.stringify(value);
}

function recordKey(action: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(action) ? action : quote(action);
}

function topLevelConsts(program: Estree): ReadonlyMap<string, Estree> {
  const consts = new Map<string, Estree>();
  for (const statement of nodes(program.body)) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type !== "VariableDeclaration") {
      continue;
    }
    for (const declarator of nodes(declaration.declarations)) {
      const name =
        declarator.id?.type === "Identifier" ? declarator.id.name : undefined;
      if (name !== undefined && declarator.init) {
        consts.set(name, declarator.init);
      }
    }
  }
  return consts;
}

/**
 * Reads through `as`, `satisfies` and a top-level `const` the literal sits in,
 * so `definePermissions({ file })` reaches `const file = resource(…)`.
 */
function resolver(consts: ReadonlyMap<string, Estree>) {
  return function resolve(node: Estree | null | undefined): Estree | undefined {
    let current = node ?? undefined;
    const seen = new Set<string>();
    while (current !== undefined) {
      if (WRAPPERS.has(current.type)) {
        current = child(current, "expression");
        continue;
      }
      if (current.type === "Identifier" && current.name !== undefined) {
        if (seen.has(current.name)) {
          return undefined;
        }
        seen.add(current.name);
        current = consts.get(current.name);
        continue;
      }
      return current;
    }
    return undefined;
  };
}

function propertyNamed(object: Estree, name: string): Estree | undefined {
  return nodes(object.properties).find(
    (property) => propertyKey(property) === name,
  );
}

function definePermissionsCall(file: string, program: Estree): Estree {
  const calls: Estree[] = [];
  walk(program, (node) => {
    if (
      node.type === "CallExpression" &&
      nameOf(node.callee) === "definePermissions"
    ) {
      calls.push(node);
    }
  });
  const [call] = calls;
  if (call === undefined || calls.length > 1) {
    throw configError(
      `PermDock CLI: ${file} needs exactly one definePermissions(...) call for keys rename, found ${String(calls.length)}`,
    );
  }
  return call;
}

function byHand(file: string, key: string, why: string): Error {
  return configError(
    `PermDock CLI: keys rename cannot edit ${key} in ${file}: ${why}. Edit the tree by hand, or write it as resource({ actions: [...] }) literals`,
  );
}

function resourceSite(
  file: string,
  tree: Estree,
  path: readonly string[],
  resolve: (node: Estree | null | undefined) => Estree | undefined,
): ResourceSite {
  const label = path.join(".");
  let container = resolve(tree);
  let property: Estree | undefined;
  for (const segment of path) {
    if (container?.type !== "ObjectExpression") {
      throw byHand(file, label, `${segment} is not in an object literal`);
    }
    property = propertyNamed(container, segment);
    if (property === undefined) {
      throw byHand(file, label, `no property ${segment}`);
    }
    if (segment !== path.at(-1)) {
      container = resolve(child(property, "value"));
    }
  }
  const call = resolve(
    property === undefined ? undefined : child(property, "value"),
  );
  if (
    property === undefined ||
    container === undefined ||
    call?.type !== "CallExpression" ||
    nameOf(call.callee) !== "resource"
  ) {
    throw byHand(file, label, "it is not a resource(...) call");
  }
  const options = nodes(call.arguments).findLast(
    (argument) => argument.type === "ObjectExpression",
  );
  if (options === undefined) {
    throw byHand(file, label, "resource(...) has no options object");
  }
  return { container, property, options };
}

function actionSite(
  file: string,
  label: string,
  options: Estree,
  action: string,
  resolve: (node: Estree | null | undefined) => Estree | undefined,
): ActionSite | undefined {
  for (const kind of ["actions", "collection"] as const) {
    const property = propertyNamed(options, kind);
    if (property === undefined) {
      continue;
    }
    const list = resolve(child(property, "value"));
    if (list?.type === "ArrayExpression") {
      const item = nodes(list.elements).find(
        (element) => nameOf(element) === action && element.type === "Literal",
      );
      if (item !== undefined) {
        return { kind, list, item };
      }
    } else if (list?.type === "ObjectExpression") {
      const item = propertyNamed(list, action);
      if (item !== undefined) {
        return { kind, list, item };
      }
    } else {
      throw byHand(file, label, `${kind} is not an array or object literal`);
    }
  }
  return undefined;
}

function listOf(
  file: string,
  label: string,
  options: Estree,
  kind: ListKind,
  resolve: (node: Estree | null | undefined) => Estree | undefined,
): Estree | undefined {
  const property = propertyNamed(options, kind);
  if (property === undefined) {
    return undefined;
  }
  const list = resolve(child(property, "value"));
  if (list?.type !== "ArrayExpression" && list?.type !== "ObjectExpression") {
    throw byHand(file, label, `${kind} is not an array or object literal`);
  }
  return list;
}

function itemsOf(list: Estree): readonly Estree[] {
  return list.type === "ArrayExpression"
    ? nodes(list.elements)
    : nodes(list.properties);
}

/** The text of the moved action in the target list's form. */
function movedItem(
  text: string,
  file: string,
  to: string,
  from: ActionSite,
  action: string,
  target: "array" | "record",
): string {
  const value =
    from.item?.type === "Property" ? child(from.item, "value") : undefined;
  const valueText =
    value === undefined ? "{}" : text.slice(value.start, value.end);
  if (target === "array") {
    if (valueText.replaceAll(/\s/gu, "") !== "{}") {
      throw byHand(
        file,
        to,
        "the action carries meta and the target lists actions as an array",
      );
    }
    return quote(action);
  }
  return `${recordKey(action)}: ${valueText}`;
}

function renamedEdits(
  file: string,
  text: string,
  call: Estree,
  from: string,
  to: string,
  resolve: (node: Estree | null | undefined) => Estree | undefined,
): readonly Edit[] {
  const entry = `${quote(from)}: ${quote(to)}`;
  const [tree, second] = nodes(call.arguments);
  if (tree === undefined) {
    throw byHand(file, from, "definePermissions(...) has no tree");
  }
  if (second === undefined) {
    return [
      { start: tree.end, end: tree.end, text: `, { renamed: { ${entry} } }` },
    ];
  }
  const options = resolve(second);
  if (options?.type !== "ObjectExpression") {
    throw byHand(
      file,
      from,
      "the definePermissions options are not an object literal",
    );
  }
  const property = propertyNamed(options, "renamed");
  if (property === undefined) {
    return [
      appendItem(
        text,
        options,
        nodes(options.properties),
        `renamed: { ${entry} }`,
      ),
    ];
  }
  const renamed = resolve(child(property, "value"));
  if (renamed?.type !== "ObjectExpression") {
    throw byHand(file, from, "renamed is not an object literal");
  }
  const edits: Edit[] = [];
  for (const old of nodes(renamed.properties)) {
    const value = child(old, "value");
    if (value?.type === "Literal" && value.value === from) {
      edits.push({ start: value.start, end: value.end, text: quote(to) });
    }
  }
  edits.push(appendItem(text, renamed, nodes(renamed.properties), entry));
  return edits;
}

function split(key: string): {
  readonly path: readonly string[];
  readonly action: string;
} {
  const segments = key.split(".");
  return { path: segments.slice(0, -1), action: segments.at(-1) ?? "" };
}

/**
 * Rewrites the permissions module so `from` becomes a former key of `to`: the
 * action leaves `from`'s resource, joins `to`'s unless `to` already exists, and
 * `definePermissions(..., { renamed })` maps `from` (and every key that mapped
 * to it) to `to`. A resource left with no action is removed.
 */
export function renameInTree(input: {
  readonly file: string;
  readonly text: string;
  readonly from: string;
  readonly to: string;
  /** `to` is already a permission key, so only `from` goes. */
  readonly merge: boolean;
}): TreeRename {
  const { file, text, from, to } = input;
  const program = parseProgram(file, text);
  if (program === undefined) {
    throw configError(`PermDock CLI: ${file} does not parse`);
  }
  const resolve = resolver(topLevelConsts(program));
  const call = definePermissionsCall(file, program);
  const tree = nodes(call.arguments)[0];
  if (tree === undefined) {
    throw byHand(file, from, "definePermissions(...) has no tree");
  }
  const source = split(from);
  const target = split(to);
  const fromResource = resourceSite(file, tree, source.path, resolve);
  const fromSite = actionSite(
    file,
    from,
    fromResource.options,
    source.action,
    resolve,
  );
  if (fromSite?.item === undefined) {
    throw byHand(
      file,
      from,
      `${source.action} is not in its actions or collection literal`,
    );
  }
  const notes: string[] = [];
  const edits: Edit[] = [];
  const sameResource = source.path.join(".") === target.path.join(".");
  const remaining =
    itemsOf(fromSite.list).length -
    1 +
    (["actions", "collection"] as const)
      .filter((kind) => kind !== fromSite.kind)
      .map((kind) => {
        const list = listOf(file, from, fromResource.options, kind, resolve);
        return list === undefined ? 0 : itemsOf(list).length;
      })
      .reduce((sum, count) => sum + count, 0);
  if (sameResource && !input.merge) {
    edits.push(
      fromSite.list.type === "ArrayExpression"
        ? {
            start: fromSite.item.start,
            end: fromSite.item.end,
            text: quote(target.action),
          }
        : {
            start: fromSite.item.key?.start ?? fromSite.item.start,
            end: fromSite.item.key?.end ?? fromSite.item.start,
            text: recordKey(target.action),
          },
    );
  } else {
    if (remaining === 0 && !sameResource) {
      edits.push(
        removeProperty(text, fromResource.container, fromResource.property),
      );
      notes.push(
        `removed resource ${source.path.join(".")}, which had no other action: move its relations, parent and restricted onto ${target.path.join(".")} if they are still needed`,
      );
    } else {
      edits.push(
        fromSite.list.type === "ArrayExpression"
          ? removeElement(text, fromSite.list, fromSite.item)
          : removeProperty(text, fromSite.list, fromSite.item),
      );
    }
    if (!input.merge) {
      const toResource = resourceSite(file, tree, target.path, resolve);
      const list = listOf(file, to, toResource.options, fromSite.kind, resolve);
      if (list === undefined) {
        const form =
          fromSite.list.type === "ArrayExpression" ? "array" : "record";
        const item = movedItem(text, file, to, fromSite, target.action, form);
        edits.push(
          appendItem(
            text,
            toResource.options,
            nodes(toResource.options.properties),
            form === "array"
              ? `${fromSite.kind}: [${item}]`
              : `${fromSite.kind}: { ${item} }`,
          ),
        );
      } else {
        const form = list.type === "ArrayExpression" ? "array" : "record";
        edits.push(
          appendItem(
            text,
            list,
            itemsOf(list),
            movedItem(text, file, to, fromSite, target.action, form),
          ),
        );
      }
    }
  }
  edits.push(...renamedEdits(file, text, call, from, to, resolve));
  let rewritten: string;
  try {
    rewritten = applyEditsStrict(text, edits);
  } catch {
    throw byHand(file, from, "its edits overlap");
  }
  if (parseProgram(file, rewritten) === undefined) {
    throw byHand(file, from, "the rewrite does not parse");
  }
  return { text: rewritten, notes };
}
