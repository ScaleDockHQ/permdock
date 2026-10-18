import type {
  CodemodFollowUp,
  Context,
  ImportBinding,
  RenameSet,
} from "./context.ts";
import type { AwaitRename, PropRename } from "./shapes-0.5.ts";

import {
  type Estree,
  child,
  type LineAt,
  nameOf,
  nodes,
  position,
} from "./ast.ts";
import {
  boundImport,
  SCRIPT_BLOCK,
  edit,
  importedCallee,
  renameKeys,
  replace,
} from "./context.ts";
import { importedLocal } from "./imports.ts";

export function templateHints(
  file: string,
  source: string,
  set: RenameSet,
  components: ReadonlySet<string>,
  lineAt: LineAt,
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

export function awaitRow(
  ctx: Context,
  callee: { readonly entry: string; readonly imported: string } | undefined,
): AwaitRename | undefined {
  return (ctx.set.awaits ?? []).find(
    (row) =>
      callee !== undefined &&
      row.name === callee.imported &&
      row.entries.includes(callee.entry),
  );
}

export function visitAwait(
  ctx: Context,
  node: Estree,
  ancestors: readonly Estree[],
): void {
  const call = node.argument;
  if (call?.type !== "CallExpression" || call.callee === undefined) {
    return;
  }
  const callee = importedCallee(ctx, call.callee, ancestors);
  const row = awaitRow(ctx, callee);
  if (row === undefined || callee === undefined) {
    return;
  }
  swapCallee(ctx, call.callee, row.name, row.to, callee.entry, ancestors);
}

function swapCallee(
  ctx: Context,
  callee: Estree,
  from: string,
  to: string,
  entry: string,
  ancestors: readonly Estree[],
): boolean {
  if (callee.type === "MemberExpression" && callee.property !== undefined) {
    replace(ctx, callee.property, to, from);
    return true;
  }
  const local = importedLocal(ctx, to, entry, ancestors);
  if (local === undefined) {
    ctx.followUps.push({
      at: callee.start,
      name: from,
      message: `\`${from}\` is \`${to}\` from \`${entry}\` here; \`${to}\` is already bound in this scope`,
    });
    return false;
  }
  ctx.consumed.add(callee.start);
  edit(ctx, callee, local, from, to);
  return true;
}

export function reportUnawaited(
  ctx: Context,
  node: Estree,
  ancestors: readonly Estree[],
  row: AwaitRename,
): void {
  const parent = ancestors.at(-1);
  const settles =
    parent?.type === "ReturnStatement" ||
    (parent?.type === "ArrowFunctionExpression" && parent.body === node) ||
    (parent?.type === "MemberExpression" &&
      parent.object === node &&
      parent.property?.name === "then");
  if (settles) {
    ctx.followUps.push({
      at: node.start,
      name: row.name,
      message: `\`${row.name}\` returns the instance, never a Promise; call \`${row.to}\` when a source answers asynchronously`,
    });
  }
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

export function visitElement(
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

export function visitComponentArguments(
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
