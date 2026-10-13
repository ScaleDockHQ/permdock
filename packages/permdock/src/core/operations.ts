import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { Permission, PermissionTree } from "./permission-types.ts";

import { isForbiddenKey } from "./paths.ts";
import { isPermission, listPermissions } from "./permission-registry.ts";

export type OperationRisk = "low" | "medium" | "high" | "critical";

export type OperationEffect =
  | "read"
  | "write"
  | "delete"
  | "send"
  | "spend"
  | "external";

export const OPERATION_RISKS: readonly OperationRisk[] = Object.freeze([
  "low",
  "medium",
  "high",
  "critical",
]);

export const OPERATION_EFFECTS: readonly OperationEffect[] = Object.freeze([
  "read",
  "write",
  "delete",
  "send",
  "spend",
  "external",
]);

/** Plain JSON a host reads to label, confirm or gate an operation; PermDock never decides on it. */
export type OperationMeta = {
  readonly risk?: OperationRisk;
  /** What running the operation does, each effect at most once. */
  readonly effects?: readonly OperationEffect[];
  readonly title?: string;
};

/** One entry of the object passed to `defineOperations`. */
export type OperationDefinition = {
  readonly permission: Permission;
  /** A Standard Schema for the operation's input. */
  readonly data?: StandardSchemaV1;
  /** The permission each result row is filtered by. */
  readonly results?: Permission;
  readonly meta?: OperationMeta;
};

/**
 * A permission-bound action that agent tools, workflow nodes, MCP operations,
 * HTTP routes and chat commands read by name. `TInput` is the output type of
 * `data`; an operation without `data` takes `undefined`.
 */
export type Operation<
  TInput = unknown,
  TName extends string = string,
  TPermission extends Permission = Permission,
> = {
  readonly name: TName;
  readonly permission: TPermission;
  readonly data?: StandardSchemaV1<unknown, TInput>;
  readonly results?: Permission;
  readonly meta: OperationMeta;
};

/** The input type of an operation: the output type of its `data` schema. */
export type OperationInput<TOperation> =
  TOperation extends Operation<infer TInput> ? TInput : never;

type InputOf<TDefinition> = TDefinition extends {
  readonly data: infer TData extends StandardSchemaV1;
}
  ? StandardSchemaV1.InferOutput<TData>
  : undefined;

export type OperationMap<
  TDefinitions extends Record<string, OperationDefinition> = Record<
    string,
    OperationDefinition
  >,
> = {
  readonly [TName in keyof TDefinitions & string]: Operation<
    InputOf<TDefinitions[TName]>,
    TName,
    TDefinitions[TName]["permission"]
  >;
};

/** MCP tool-name characters (MCP 2025-11-25, Tools: Tool names), so a name works as a tool name unchanged. */
const NAME = /^[A-Za-z0-9_.-]{1,128}$/u;

const META_KEYS: ReadonlySet<string> = new Set(["risk", "effects", "title"]);

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return false;
  }
  const standard: unknown = Reflect.get(value, "~standard");
  return (
    standard !== null &&
    typeof standard === "object" &&
    typeof Reflect.get(standard, "version") === "number" &&
    typeof Reflect.get(standard, "validate") === "function"
  );
}

export function isOperationRisk(value: unknown): value is OperationRisk {
  return OPERATION_RISKS.some((risk) => risk === value);
}

export function isOperationEffect(value: unknown): value is OperationEffect {
  return OPERATION_EFFECTS.some((effect) => effect === value);
}

function readMeta(name: string, value: unknown): OperationMeta {
  if (value === undefined) {
    return Object.freeze({});
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Operation "${name}": meta must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!META_KEYS.has(key)) {
      throw new TypeError(
        `Operation "${name}": meta.${key} is not one of risk, effects, title.`,
      );
    }
  }
  const meta: {
    risk?: OperationRisk;
    effects?: readonly OperationEffect[];
    title?: string;
  } = {};
  const risk: unknown = Reflect.get(value, "risk");
  if (risk !== undefined) {
    if (!isOperationRisk(risk)) {
      throw new TypeError(
        `Operation "${name}": meta.risk must be one of ${OPERATION_RISKS.join(", ")}.`,
      );
    }
    meta.risk = risk;
  }
  const effects: unknown = Reflect.get(value, "effects");
  if (effects !== undefined) {
    if (
      !Array.isArray(effects) ||
      !effects.every(isOperationEffect) ||
      new Set(effects).size !== effects.length
    ) {
      throw new TypeError(
        `Operation "${name}": meta.effects must list distinct values of ${OPERATION_EFFECTS.join(", ")}.`,
      );
    }
    meta.effects = Object.freeze([...effects]);
  }
  const title: unknown = Reflect.get(value, "title");
  if (title !== undefined) {
    if (typeof title !== "string" || title.trim() === "") {
      throw new TypeError(
        `Operation "${name}": meta.title must be a non-empty string.`,
      );
    }
    meta.title = title;
  }
  return Object.freeze(meta);
}

function treeLeaf(
  keys: ReadonlyMap<string, Permission>,
  name: string,
  field: "permission" | "results",
  value: unknown,
): Permission {
  if (!isPermission(value)) {
    throw new TypeError(
      `Operation "${name}": ${field} must be a permission from the tree.`,
    );
  }
  if (!keys.has(value.key)) {
    throw new TypeError(
      `Operation "${name}": ${field} ${value.key} is not a permission of the tree passed to defineOperations.`,
    );
  }
  return value;
}

/**
 * Binds each named operation to a permission of `permissions`. Throws at
 * definition time for a permission or `results` outside the tree, a name that
 * is not 1 to 128 of `A-Z a-z 0-9 _ . -` or repeats another case-insensitively,
 * a `data` that is not a Standard Schema, or meta outside the closed lists.
 */
export function defineOperations<
  const TDefinitions extends Record<string, OperationDefinition>,
>(
  permissions: PermissionTree,
  definitions: TDefinitions,
): OperationMap<TDefinitions> {
  const keys = new Map(
    listPermissions(permissions).map((leaf) => [leaf.key, leaf] as const),
  );
  const seen = new Map<string, string>();
  const out: Record<string, Operation> = {};
  for (const name of Object.keys(definitions)) {
    if (!NAME.test(name) || isForbiddenKey(name)) {
      throw new TypeError(
        `Operation name "${name}" must be 1 to 128 of A-Z a-z 0-9 _ . -.`,
      );
    }
    const folded = name.toLowerCase();
    const previous = seen.get(folded);
    if (previous !== undefined) {
      throw new TypeError(
        `Operation name "${name}" is a duplicate of "${previous}".`,
      );
    }
    seen.set(folded, name);
    const definition: unknown = definitions[name];
    if (
      definition === null ||
      typeof definition !== "object" ||
      Array.isArray(definition)
    ) {
      throw new TypeError(`Operation "${name}" must be an object.`);
    }
    const permission = treeLeaf(
      keys,
      name,
      "permission",
      Reflect.get(definition, "permission"),
    );
    const data: unknown = Reflect.get(definition, "data");
    if (data !== undefined && !isStandardSchema(data)) {
      throw new TypeError(
        `Operation "${name}": data must be a Standard Schema.`,
      );
    }
    const resultsValue: unknown = Reflect.get(definition, "results");
    const results =
      resultsValue === undefined
        ? undefined
        : treeLeaf(keys, name, "results", resultsValue);
    const meta = readMeta(name, Reflect.get(definition, "meta"));
    out[name] = Object.freeze({
      name,
      permission,
      ...(data === undefined ? {} : { data }),
      ...(results === undefined ? {} : { results }),
      meta,
    });
  }
  // SAFETY: every own key of definitions became the frozen operation of that name.
  return Object.freeze(out) as OperationMap<TDefinitions>;
}
