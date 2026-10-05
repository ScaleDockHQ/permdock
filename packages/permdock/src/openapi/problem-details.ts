import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";

import type { ProblemDetails } from "../core/errors.ts";

const TARGETS: ReadonlySet<string> = new Set([
  "draft-2020-12",
  "draft-07",
  "openapi-3.0",
]);

const JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  description: "RFC 9457 Problem Details for a PermDock denial",
  required: ["type", "title", "status", "detail"],
  properties: {
    type: { type: "string", format: "uri-reference" },
    title: { type: "string" },
    status: { type: "integer", minimum: 400, maximum: 599 },
    detail: { type: "string" },
    instance: { type: "string" },
    permission: { type: "string" },
    scope: { type: "string" },
    reason: { type: "string" },
  },
  additionalProperties: true,
});

const REQUIRED_STRINGS = ["type", "title", "detail"] as const;

function issuesOf(value: unknown): readonly StandardSchemaV1.Issue[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [{ message: "Expected a Problem Details object" }];
  }
  const issues: StandardSchemaV1.Issue[] = [];
  const fields: ReadonlyMap<string, unknown> = new Map(Object.entries(value));
  for (const key of REQUIRED_STRINGS) {
    if (typeof fields.get(key) !== "string") {
      issues.push({ message: `Expected a string`, path: [key] });
    }
  }
  const status = fields.get("status");
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 400 ||
    status > 599
  ) {
    issues.push({ message: "Expected an HTTP error status", path: ["status"] });
  }
  return issues;
}

function isProblem(value: unknown): value is ProblemDetails {
  return issuesOf(value).length === 0;
}

function jsonSchema(
  options: StandardJSONSchemaV1.Options,
): Record<string, unknown> {
  if (!TARGETS.has(options.target)) {
    throw new TypeError(
      `PermDock: problemDetails has no JSON Schema for target ${options.target}`,
    );
  }
  return structuredClone(JSON_SCHEMA);
}

/**
 * The Problem Details body the adapters send on a denial, as a Standard
 * Schema with a JSON Schema, for `oc.errors({ FORBIDDEN: { data: problemDetails } })`.
 * Extension members pass through: RFC 9457 lets a problem type add them.
 */
export const problemDetails: StandardSchemaV1<ProblemDetails> &
  StandardJSONSchemaV1<ProblemDetails> = Object.freeze({
  "~standard": Object.freeze({
    version: 1 as const,
    vendor: "permdock",
    validate: (value: unknown): StandardSchemaV1.Result<ProblemDetails> =>
      isProblem(value) ? { value } : { issues: issuesOf(value) },
    jsonSchema: Object.freeze({ input: jsonSchema, output: jsonSchema }),
  }),
});
