import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { JsonSchemaNode, JsonSchemaType } from "../core/json-schema.ts";

import { isRecord } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import { checkSchema, copyJson } from "../core/json-schema.ts";

const ANNOTATIONS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

const NUMBERS = [
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
] as const;

const TYPES: ReadonlySet<unknown> = new Set<JsonSchemaType>([
  "object",
  "array",
  "string",
  "boolean",
  "integer",
  "number",
  "null",
]);

type Read =
  | { readonly node: JsonSchemaNode }
  | { readonly unsupported: string };

function isType(value: unknown): value is JsonSchemaType {
  return TYPES.has(value);
}

function readList(
  value: unknown,
  keyword: string,
): readonly JsonSchemaNode[] | string {
  if (!Array.isArray(value)) {
    return keyword;
  }
  const nodes: JsonSchemaNode[] = [];
  for (const item of value) {
    const read = readNode(item);
    if ("unsupported" in read) {
      return read.unsupported;
    }
    nodes.push(read.node);
  }
  return nodes;
}

function readMap(
  value: unknown,
  keyword: string,
): Readonly<Record<string, JsonSchemaNode>> | string {
  if (!isRecord(value)) {
    return keyword;
  }
  const out: Record<string, JsonSchemaNode> = {};
  for (const [key, child] of Object.entries(value)) {
    const read = readNode(child);
    if ("unsupported" in read) {
      return read.unsupported;
    }
    Object.defineProperty(out, key, {
      value: read.node,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * Reads one JSON Schema node into the subset `checkSchema` interprets. Any
 * other keyword is reported, so the caller can refuse the schema instead of
 * validating less than the code did. `format` is accepted only next to a
 * `pattern` that enforces it.
 */
function readNode(value: unknown): Read {
  if (value === true) {
    return { node: {} };
  }
  if (value === false) {
    return { node: { enum: [] } };
  }
  if (!isRecord(value)) {
    return { unsupported: "a non-object schema" };
  }
  const node: Record<string, unknown> = {};
  for (const [keyword, raw] of Object.entries(value)) {
    if (ANNOTATIONS.has(keyword)) {
      continue;
    }
    switch (keyword) {
      case "format":
        if (typeof value["pattern"] !== "string") {
          return { unsupported: "format" };
        }
        break;
      case "type":
        if (!(isType(raw) || (Array.isArray(raw) && raw.every(isType)))) {
          return { unsupported: "type" };
        }
        node["type"] = raw;
        break;
      case "const":
      case "enum":
      case "required":
      case "uniqueItems":
      case "$ref":
        node[keyword] = raw;
        break;
      case "pattern":
        if (typeof raw !== "string") {
          return { unsupported: "pattern" };
        }
        node["pattern"] = raw;
        break;
      case "minLength":
      case "maxLength":
      case "minimum":
      case "maximum":
      case "exclusiveMinimum":
      case "exclusiveMaximum":
      case "minItems":
      case "maxItems":
        if (typeof raw !== "number") {
          return { unsupported: keyword };
        }
        node[keyword] = raw;
        break;
      case "items":
      case "additionalProperties": {
        if (keyword === "additionalProperties" && raw === false) {
          node[keyword] = false;
          break;
        }
        const read = readNode(raw);
        if ("unsupported" in read) {
          return read;
        }
        node[keyword] = read.node;
        break;
      }
      case "properties":
      case "$defs": {
        const read = readMap(raw, keyword);
        if (typeof read === "string") {
          return { unsupported: read };
        }
        node[keyword] = read;
        break;
      }
      case "oneOf":
      case "anyOf":
      case "allOf": {
        const read = readList(raw, keyword);
        if (typeof read === "string") {
          return { unsupported: read };
        }
        node[keyword] = read;
        break;
      }
      default:
        return { unsupported: keyword };
    }
  }
  if (NUMBERS.some((key) => key in node && !Number.isFinite(node[key]))) {
    return { unsupported: "a non-finite bound" };
  }
  if (
    typeof node["$ref"] === "string" &&
    !/^#\/\$defs\/[^/]+$/u.test(node["$ref"])
  ) {
    return { unsupported: "$ref" };
  }
  // SAFETY: every keyword copied above was checked against the JsonSchemaNode member of the same name.
  return { node: node as JsonSchemaNode };
}

function refusing(keyword: string): StandardSchemaV1 {
  const message = `PermDock: the catalog schema uses ${keyword}, which policyFromCatalog does not interpret`;
  return freezeDeep({
    "~standard": {
      version: 1,
      vendor: "permdock",
      validate: (): StandardSchemaV1.Result<unknown> => ({
        issues: [{ message }],
      }),
    },
  });
}

/**
 * A Standard Schema that validates against a catalog resource's JSON Schema.
 * `null` (no JSON Schema in the catalog) gives `undefined`. A schema that uses
 * a keyword outside the supported subset rejects every value, so a hosted
 * check never validates less than the code did.
 */
export function resourceSchemaFromJson(
  json: unknown,
): StandardSchemaV1 | undefined {
  if (json === null || json === undefined) {
    return undefined;
  }
  const read = readNode(json);
  if ("unsupported" in read) {
    return refusing(read.unsupported);
  }
  const root = read.node;
  return freezeDeep({
    "~standard": {
      version: 1,
      vendor: "permdock",
      validate: (value: unknown): StandardSchemaV1.Result<unknown> => {
        const issues: StandardSchemaV1.Issue[] = [];
        const copy = copyJson(value, [], issues, new Set());
        if (issues.length === 0) {
          try {
            checkSchema(root, copy, [], issues);
          } catch {
            issues.push({ message: "Unresolvable $ref" });
          }
        }
        return issues.length === 0 ? { value } : { issues };
      },
    },
  });
}
