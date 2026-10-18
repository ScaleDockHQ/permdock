import { type VisitorObject, Visitor, visitorKeys } from "oxc-parser";

/** An all-optional view of an Oxc ESTree node; Oxc sets `start` and `end` on every node. */
export type Estree = {
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

export type Edit = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

export function nameOf(node: Estree | null | undefined): string | undefined {
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
export function referencePlace(
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

export function nodes(value: unknown): readonly Estree[] {
  return Array.isArray(value) ? value.filter(isNode) : [];
}

function isNode(value: unknown): value is Estree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A child node under a field `Estree` types as something else (`value`, a type parameter's `name`). */
export function child(node: Estree, field: string): Estree | undefined {
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
export function scopeBindings(node: Estree): Set<string> | undefined {
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

export function bindingsCached(
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

export function applyEdits(source: string, edits: readonly Edit[]): string {
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

export function position(
  lineAt: LineAt,
  index: number,
): { readonly line: number; readonly column: number } {
  const { line, lineStart } = lineAt(index);
  return { line, column: index - lineStart + 1 };
}

export function lineIndex(source: string): LineAt {
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
export function walk(
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
