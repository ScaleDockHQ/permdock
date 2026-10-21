import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { ApprovalRequest } from "./types.ts";

import { freezeDeep } from "../core/freeze.ts";
import {
  checkSchema,
  copyJson,
  forbiddenKeyPath,
} from "../core/json-schema.ts";
import { APPROVAL_REQUEST_SCHEMA } from "./request-schema.ts";

/**
 * Reads an `ApprovalRequest` (parsed, or the JSON text) as an approval store or
 * the Cloud returns it, validated against `schemas/approval-request-v1.json`.
 * Returns a deep-frozen copy, or `null` for anything that does not match,
 * including a `__proto__`, `constructor` or `prototype` key.
 */
export function parseApprovalRequest(value: unknown): ApprovalRequest | null {
  let input = value;
  if (typeof value === "string") {
    try {
      input = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const issues: StandardSchemaV1.Issue[] = [];
  const copy = copyJson(input, [], issues, new Set());
  if (issues.length > 0 || forbiddenKeyPath(copy) !== undefined) {
    return null;
  }
  checkSchema(APPROVAL_REQUEST_SCHEMA, copy, [], issues);
  // SAFETY: copy is plain JSON that matched APPROVAL_REQUEST_SCHEMA, the schema ApprovalRequest describes.
  return issues.length === 0 ? freezeDeep(copy as ApprovalRequest) : null;
}
