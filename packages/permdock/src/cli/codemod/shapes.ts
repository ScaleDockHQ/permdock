import type {
  CodemodFollowUp,
  Context,
  ImportBinding,
  RenameSet,
} from "./context.ts";
import type {
  AwaitRename,
  FunctionToMethod,
  MethodToFunction,
  OptionWrap,
  PropRename,
} from "./shapes-0.5.ts";

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
  isModuleBinding,
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

function methodRow(
  ctx: Context,
  node: Estree,
  ancestors: readonly Estree[],
): MethodToFunction | undefined {
  const callee = node.callee;
  const receiver = callee?.object;
  const method = callee?.property?.name;
  const first = nodes(node.arguments)[0];
  return (ctx.set.methodFunctions ?? []).find(
    (row) =>
      callee?.type === "MemberExpression" &&
      callee.computed !== true &&
      row.method === method &&
      (row.argument === undefined ||
        (first?.type === "ObjectExpression" &&
          nodes(first.properties).some(
            (property) => nameOf(property.key) === row.argument,
          ))) &&
      (row.anyReceiver || holdsInstance(ctx, receiver, ancestors)),
  );
}

function holdsInstance(
  ctx: Context,
  receiver: Estree | undefined,
  ancestors: readonly Estree[],
): boolean {
  const name = receiver?.type === "Identifier" ? receiver.name : undefined;
  if (name === undefined) {
    return false;
  }
  return (
    /permdock/iu.test(name) ||
    (isModuleBinding(ctx, name, ancestors) && ctx.factories.has(name))
  );
}

export function visitMethodCall(
  ctx: Context,
  node: Estree,
  ancestors: readonly Estree[],
): void {
  const row =
    node.type === "CallExpression"
      ? methodRow(ctx, node, ancestors)
      : undefined;
  const receiver = node.callee?.object;
  if (row === undefined || receiver === undefined) {
    return;
  }
  const name = receiver.type === "Identifier" ? receiver.name : undefined;
  if (name !== undefined && ctx.namespaces.has(name)) {
    return;
  }
  const open = ctx.code.indexOf("(", receiver.end);
  const between = ctx.code.slice(receiver.end, open);
  const optional =
    Reflect.get(node, "optional") === true ||
    Reflect.get(node.callee ?? node, "optional") === true;
  if (
    optional ||
    receiver.type === "SequenceExpression" ||
    !/^\s*\.\s*\w+\s*$/u.test(between)
  ) {
    ctx.followUps.push({
      at: node.start,
      name: row.method,
      message: `\`permdock.${row.method}(…)\` is \`${row.to}(permdock, …)\` from \`${row.entry}\``,
    });
    return;
  }
  const local = importedLocal(ctx, row.to, row.entry, ancestors);
  if (local === undefined) {
    ctx.followUps.push({
      at: node.start,
      name: row.method,
      message: `\`permdock.${row.method}(…)\` is \`${row.to}(permdock, …)\` from \`${row.entry}\`; \`${row.to}\` is already bound in this scope`,
    });
    return;
  }
  const separator = nodes(node.arguments).length === 0 ? "" : ",";
  const space = /\s/u.test(ctx.code[open + 1] ?? "") ? "" : " ";
  ctx.edits.push(
    { start: receiver.start, end: receiver.start, text: `${local}(` },
    {
      start: receiver.end,
      end: open + 1,
      text: separator === "" ? "" : `${separator}${space}`,
    },
  );
  ctx.changes.push({ at: node.start, from: row.method, to: row.to });
}

const PLAIN_RECEIVERS: ReadonlySet<string> = new Set([
  "Identifier",
  "MemberExpression",
  "CallExpression",
  "ThisExpression",
]);

export function visitFunctionCall(
  ctx: Context,
  node: Estree,
  callee: { readonly entry: string; readonly imported: string },
): boolean {
  const row = (ctx.set.functionMethods ?? []).find(
    (item: FunctionToMethod) =>
      item.name === callee.imported && item.entry === callee.entry,
  );
  const args = nodes(node.arguments);
  const [receiver, next] = args;
  if (
    row === undefined ||
    node.type !== "CallExpression" ||
    node.callee === undefined ||
    receiver === undefined ||
    receiver.type === "SpreadElement" ||
    Reflect.get(node, "optional") === true
  ) {
    return false;
  }
  const plain = PLAIN_RECEIVERS.has(receiver.type);
  ctx.edits.push(
    {
      start: node.callee.start,
      end: receiver.start,
      text: plain ? "" : "(",
    },
    {
      start: receiver.end,
      end: next?.start ?? node.end - 1,
      text: `${plain ? "" : ")"}.${row.method}(`,
    },
  );
  if (node.callee.type === "Identifier") {
    ctx.consumed.add(node.callee.start);
  }
  ctx.changes.push({ at: node.start, from: row.name, to: row.method });
  return true;
}

function isWrapped(
  ctx: Context,
  row: OptionWrap,
  value: Estree | undefined,
  ancestors: readonly Estree[],
): boolean {
  const callee =
    value?.type === "CallExpression"
      ? importedCallee(ctx, value.callee, ancestors)
      : undefined;
  return (
    callee !== undefined &&
    callee.entry === row.entry &&
    row.already.includes(callee.imported)
  );
}

export function visitWraps(
  ctx: Context,
  node: Estree,
  callee: { readonly entry: string; readonly imported: string },
  ancestors: readonly Estree[],
): void {
  const rows = (ctx.set.wraps ?? []).filter(
    (row) =>
      row.entries.includes(callee.entry) && row.calls.includes(callee.imported),
  );
  for (const argument of nodes(node.arguments)) {
    for (const property of argument.type === "ObjectExpression"
      ? nodes(argument.properties)
      : []) {
      const row = rows.find((item) => item.key === nameOf(property.key));
      if (row !== undefined && property.computed !== true) {
        wrapOption(ctx, row, property, ancestors);
      }
    }
  }
}

function wrapOption(
  ctx: Context,
  row: OptionWrap,
  property: Estree,
  ancestors: readonly Estree[],
): void {
  const value = child(property, "value");
  if (property.key !== undefined) {
    ctx.handledKeys.add(property.key);
  }
  if (value === undefined || isWrapped(ctx, row, value, ancestors)) {
    return;
  }
  const local = importedLocal(ctx, row.wrapper, row.entry, ancestors);
  if (local === undefined || property.type !== "Property") {
    ctx.followUps.push({
      at: property.start,
      name: row.key,
      message: `option \`${row.key}\` takes \`${row.wrapper}(source)\` from \`${row.entry}\`; \`${row.wrapper}\` is already bound in this scope`,
    });
    return;
  }
  ctx.edits.push(
    property.shorthand === true
      ? {
          start: property.start,
          end: property.start,
          text: `${row.key}: ${local}(`,
        }
      : { start: value.start, end: value.start, text: `${local}(` },
    { start: value.end, end: value.end, text: ")" },
  );
  ctx.changes.push({ at: value.start, from: row.key, to: row.wrapper });
}

export function reportWraps(
  ctx: Context,
  node: Estree,
  ancestors: readonly Estree[],
): void {
  for (const property of nodes(node.properties)) {
    const row = (ctx.set.wraps ?? []).find(
      (item) => item.reportElsewhere && item.key === nameOf(property.key),
    );
    if (
      row !== undefined &&
      property.key !== undefined &&
      property.computed !== true &&
      !ctx.handledKeys.has(property.key) &&
      !isWrapped(ctx, row, child(property, "value"), ancestors)
    ) {
      ctx.followUps.push({
        at: property.start,
        name: row.key,
        message: `option \`${row.key}\` takes \`${row.wrapper}(source)\` from \`${row.entry}\` when this object reaches \`createPermDock\` or \`loadPermDock\``,
      });
    }
  }
}
