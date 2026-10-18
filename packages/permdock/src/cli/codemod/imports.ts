import type { Context, ImportBinding } from "./context.ts";

import { type Estree, nodes } from "./ast.ts";
import { declaredBetween, isPermDockSpecifier } from "./context.ts";

export function removableBindings(ctx: Context): ReadonlySet<string> {
  const out = new Set<string>();
  if (ctx.keepLocals) {
    return out;
  }
  for (const local of ctx.bindings.keys()) {
    const references = ctx.references.filter(
      (item) => item.node.name === local,
    );
    if (
      references.length > 0 &&
      references.every((item) => ctx.consumed.has(item.node.start))
    ) {
      out.add(local);
    }
  }
  return out;
}

export function importedLocal(
  ctx: Context,
  name: string,
  entry: string,
  ancestors: readonly Estree[],
): string | undefined {
  for (const [local, binding] of ctx.bindings) {
    if (
      binding.entry === entry &&
      binding.imported === name &&
      !typeOnly(binding) &&
      !declaredBetween(ctx, local, ancestors)
    ) {
      return local;
    }
  }
  if (ctx.moduleNames.has(name) || declaredBetween(ctx, name, ancestors)) {
    return undefined;
  }
  const names = ctx.additions.get(entry) ?? new Set();
  names.add(name);
  ctx.additions.set(entry, names);
  return name;
}

function typeOnly(binding: ImportBinding): boolean {
  return (
    Reflect.get(binding.declaration, "importKind") === "type" ||
    Reflect.get(binding.spec, "importKind") === "type"
  );
}

export function finishImports(
  ctx: Context,
  removed: ReadonlySet<string>,
): void {
  const gone = new Set<Estree>();
  for (const local of removed) {
    const spec = ctx.bindings.get(local)?.spec;
    if (spec !== undefined) {
      gone.add(spec);
    }
  }
  const pending = new Map(ctx.additions);
  for (const declaration of nodes(ctx.program.body)) {
    const all = nodes(declaration.specifiers);
    if (
      declaration.type !== "ImportDeclaration" ||
      !all.some((spec) => gone.has(spec))
    ) {
      continue;
    }
    if (all.some((spec) => spec.type !== "ImportSpecifier")) {
      for (const spec of all) {
        gone.delete(spec);
      }
      continue;
    }
    if (all.some((spec) => !gone.has(spec))) {
      removeSpecifiers(ctx, all, gone);
      continue;
    }
    const entry = String(declaration.source?.value);
    const names =
      Reflect.get(declaration, "importKind") === "type"
        ? undefined
        : pending.get(entry);
    if (names === undefined) {
      ctx.edits.push({
        start: declaration.start,
        end: lineEnd(ctx.code, declaration.end),
        text: "",
      });
    } else {
      pending.delete(entry);
      ctx.edits.push({
        start: declaration.start,
        end: declaration.end,
        text: importText(ctx, entry, names),
      });
    }
  }
  for (const [entry, names] of pending) {
    addImport(ctx, entry, names, gone);
  }
}

function lineEnd(code: string, end: number): number {
  return code[end] === "\n" ? end + 1 : end;
}

function importText(
  ctx: Context,
  entry: string,
  names: ReadonlySet<string>,
): string {
  const source = nodes(ctx.program.body)
    .map((statement) => statement.source)
    .find((node) => isPermDockSpecifier(node?.value));
  const mark = ctx.code[source?.start ?? -1] ?? '"';
  return `import { ${[...names].join(", ")} } from ${mark}${entry}${mark};`;
}

function removeSpecifiers(
  ctx: Context,
  all: readonly Estree[],
  gone: ReadonlySet<Estree>,
): void {
  const last = all.findLastIndex((spec) => !gone.has(spec));
  for (const [index, spec] of all.entries()) {
    const next = all[index + 1];
    if (gone.has(spec) && index < last && next !== undefined) {
      ctx.edits.push({ start: spec.start, end: next.start, text: "" });
    }
  }
  const survivor = all[last];
  const tail = all.at(-1);
  if (survivor !== undefined && tail !== undefined && tail !== survivor) {
    ctx.edits.push({ start: survivor.end, end: tail.end, text: "" });
  }
}

function addImport(
  ctx: Context,
  entry: string,
  names: ReadonlySet<string>,
  gone: ReadonlySet<Estree>,
): void {
  const statements = nodes(ctx.program.body);
  const anchor = statements
    .filter(
      (statement) =>
        statement.type === "ImportDeclaration" &&
        statement.source?.value === entry &&
        Reflect.get(statement, "importKind") !== "type",
    )
    .flatMap((statement) => nodes(statement.specifiers))
    .findLast((spec) => spec.type === "ImportSpecifier" && !gone.has(spec));
  if (anchor !== undefined) {
    ctx.edits.push({
      start: anchor.end,
      end: anchor.end,
      text: `, ${[...names].join(", ")}`,
    });
    return;
  }
  const lastImport = statements.findLast(
    (statement) => statement.type === "ImportDeclaration",
  );
  const at = lastImport?.end ?? 0;
  const text = importText(ctx, entry, names);
  ctx.edits.push({
    start: at,
    end: at,
    text: lastImport === undefined ? `${text}\n` : `\n${text}`,
  });
}
