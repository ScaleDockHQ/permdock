/** An RFC 3339 instant as `Temporal.Instant` prints it; pg_jsonschema asserts no `format`. */
const INSTANT = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`;

const STRINGS = { type: "array", items: { type: "string" } } as const;

/**
 * `schemas/approval-request-v1.json`: the `ApprovalRequest` an approval store
 * holds. Self-contained (`$defs`, no remote `$ref`) so `rls.jsonSchema` can
 * inline it into a pg_jsonschema check constraint.
 */
export const APPROVAL_REQUEST_SCHEMA: Readonly<Record<string, unknown>> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://permdock.com/schemas/approval-request-v1.json",
  title: "PermDock approval request",
  description:
    "An ApprovalRequest as an ApprovalStore holds it, wire format v1. Unknown properties are allowed so a v1 minor release can add one.",
  type: "object",
  required: [
    "v",
    "token",
    "permission",
    "scope",
    "resource",
    "subject",
    "detail",
    "createdAt",
    "expiresAt",
    "status",
  ],
  properties: {
    v: { const: 1 },
    token: { type: "string", minLength: 1 },
    permission: { type: "string", minLength: 1 },
    scope: { type: "string" },
    resource: {
      type: "object",
      required: ["type"],
      properties: { type: { type: "string" }, id: { type: "string" } },
    },
    subject: { $ref: "#/$defs/subject" },
    membership: {
      type: "object",
      required: ["roles"],
      properties: { roles: STRINGS },
    },
    approvers: { type: "object" },
    detail: { type: "string" },
    adapter: { type: "string" },
    createdAt: { $ref: "#/$defs/instant" },
    expiresAt: { $ref: "#/$defs/instant" },
    status: { enum: ["pending", "approved", "rejected", "expired"] },
    approvals: { type: "array", items: { $ref: "#/$defs/signature" } },
    resolvedAt: { $ref: "#/$defs/instant" },
    resolvedBy: { type: "string" },
    vouched: { type: "string" },
    note: { type: "string" },
    consumedAt: { $ref: "#/$defs/instant" },
  },
  $defs: {
    instant: { type: "string", pattern: INSTANT },
    subject: {
      type: "object",
      required: ["principal"],
      properties: {
        principal: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              required: ["id", "roles"],
              properties: {
                id: { type: "string" },
                roles: STRINGS,
                tenant: { type: "string" },
              },
            },
          ],
        },
        actor: {
          type: "object",
          required: ["id", "kind"],
          properties: { id: { type: "string" }, kind: { type: "string" } },
        },
        session: { type: "string" },
        delegation: { type: "object" },
      },
    },
    signature: {
      type: "object",
      required: ["by", "at"],
      properties: {
        by: { type: "string" },
        at: { $ref: "#/$defs/instant" },
        stage: { type: "integer", minimum: 0 },
        vouched: { type: "string" },
      },
    },
  },
};
