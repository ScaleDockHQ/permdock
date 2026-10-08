import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * The JSON Schema 2020-12 keywords the package's own schemas use;
 * `checkSchema` interprets exactly these. `$ref` resolves only `#/$defs/<name>`
 * against the root node. Annotations (`title`, `description`) are ignored.
 */
export type JsonSchemaNode = {
  readonly $schema?: string;
  readonly $id?: string;
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchemaNode>>;
  readonly title?: string;
  readonly description?: string;
  readonly type?: "object" | "array" | "string" | "boolean" | "integer";
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly pattern?: string;
  readonly minimum?: number;
  readonly minItems?: number;
  readonly uniqueItems?: boolean;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly additionalProperties?: JsonSchemaNode | false;
  readonly items?: JsonSchemaNode;
  readonly oneOf?: readonly JsonSchemaNode[];
};

type Path = readonly PropertyKey[];
type Issues = StandardSchemaV1.Issue[];

function issue(issues: Issues, path: Path, message: string): void {
  issues.push({ message, path: [...path] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A plain-data copy built from own enumerable keys, so `__proto__` stays an
 * ordinary key and nothing the input inherits is read. Anything JSON cannot
 * carry is an issue.
 */
export function copyJson(
  value: unknown,
  path: Path,
  issues: Issues,
  ancestors: Set<object>,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      issue(issues, path, "Expected a finite number");
    }
    return value;
  }
  if (typeof value !== "object") {
    issue(issues, path, `Expected JSON, got ${typeof value}`);
    return undefined;
  }
  if (ancestors.has(value)) {
    issue(issues, path, "Expected JSON, got a cycle");
    return undefined;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item: unknown, index) =>
        copyJson(item, [...path, index], issues, ancestors),
      );
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      issue(issues, path, "Expected a plain object");
      return undefined;
    }
    return Object.fromEntries(
      Object.keys(value).map((key): [string, unknown] => [
        key,
        copyJson(Reflect.get(value, key), [...path, key], issues, ancestors),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function typeMatches(
  type: NonNullable<JsonSchemaNode["type"]>,
  value: unknown,
): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isInteger(value);
    default: {
      const unreachable: never = type;
      return unreachable;
    }
  }
}

const DEF_REF = /^#\/\$defs\/([^/]+)$/u;

function resolveRef(root: JsonSchemaNode, ref: string): JsonSchemaNode {
  const name = DEF_REF.exec(ref)?.[1];
  const target =
    name !== undefined &&
    root.$defs !== undefined &&
    Object.hasOwn(root.$defs, name)
      ? root.$defs[name]
      : undefined;
  if (target === undefined) {
    throw new TypeError(`Unsupported or unknown $ref ${ref}`);
  }
  return target;
}

/** Validates a `copyJson` result against `node`, reading `$ref` targets from `root`. */
export function checkSchema(
  node: JsonSchemaNode,
  value: unknown,
  path: Path,
  issues: Issues,
  root: JsonSchemaNode = node,
): void {
  if (node.$ref !== undefined) {
    checkSchema(resolveRef(root, node.$ref), value, path, issues, root);
    return;
  }
  if ("const" in node && value !== node.const) {
    issue(issues, path, `Expected ${JSON.stringify(node.const)}`);
    return;
  }
  if (node.enum !== undefined && !node.enum.includes(value)) {
    issue(
      issues,
      path,
      `Expected one of ${node.enum.map((item) => JSON.stringify(item)).join(", ")}`,
    );
    return;
  }
  if (node.type !== undefined && !typeMatches(node.type, value)) {
    issue(issues, path, `Expected ${node.type}`);
    return;
  }
  if (
    node.pattern !== undefined &&
    typeof value === "string" &&
    !new RegExp(node.pattern, "u").test(value)
  ) {
    issue(issues, path, `Expected a string matching ${node.pattern}`);
  }
  if (
    node.minimum !== undefined &&
    typeof value === "number" &&
    value < node.minimum
  ) {
    issue(issues, path, `Expected at least ${String(node.minimum)}`);
  }
  if (node.oneOf !== undefined) {
    const matches = node.oneOf.filter((option) => {
      const scratch: Issues = [];
      checkSchema(option, value, path, scratch, root);
      return scratch.length === 0;
    }).length;
    if (matches !== 1) {
      issue(issues, path, "Expected exactly one matching form");
    }
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      issue(issues, path, `Expected at least ${String(node.minItems)} items`);
    }
    if (
      node.uniqueItems === true &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    ) {
      issue(issues, path, "Expected unique items");
    }
    if (node.items !== undefined) {
      for (const [index, item] of value.entries()) {
        checkSchema(node.items, item, [...path, index], issues, root);
      }
    }
  }
  if (!isRecord(value)) {
    return;
  }
  for (const key of node.required ?? []) {
    if (!Object.hasOwn(value, key)) {
      issue(issues, [...path, key], "Required");
    }
  }
  const properties = node.properties ?? {};
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(properties, key)) {
      const child = properties[key];
      if (child !== undefined) {
        checkSchema(child, value[key], [...path, key], issues, root);
      }
      continue;
    }
    if (node.additionalProperties === false) {
      issue(issues, [...path, key], "Unexpected property");
    } else if (node.additionalProperties !== undefined) {
      checkSchema(
        node.additionalProperties,
        value[key],
        [...path, key],
        issues,
        root,
      );
    }
  }
}
