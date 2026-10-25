const ID = { type: "string", minLength: 1, maxLength: 256 } as const;
const NUMERIC_DATE = { type: "integer", minimum: 0 } as const;
const AUDIENCE = {
  anyOf: [ID, { type: "array", items: ID, minItems: 1 }],
} as const;

/**
 * `schemas/run-v1.json`: the claims of a `vnd.permdock.run+jwt`, as
 * `signRunTicket` writes them and `parseRunTicket` accepts them. Unknown claims
 * are allowed; `parseRunTicket` drops them.
 */
export const RUN_TICKET_SCHEMA: Readonly<Record<string, unknown>> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://permdock.com/schemas/run-v1.json",
  title: "PermDock run ticket",
  description:
    "The claims of a vnd.permdock.run+jwt, wire format v1. At least one of scope and authorization_details is present; automation is present exactly when kind is automation.",
  type: "object",
  required: ["v", "iss", "sub", "aud", "jti", "iat", "exp", "kind"],
  properties: {
    v: { const: 1 },
    iss: ID,
    sub: ID,
    aud: AUDIENCE,
    jti: ID,
    iat: NUMERIC_DATE,
    exp: NUMERIC_DATE,
    kind: { enum: ["automation", "job", "caller"] },
    act: { $ref: "#/$defs/act" },
    scope: { type: "string" },
    authorization_details: {
      type: "array",
      items: {
        type: "object",
        required: ["type"],
        properties: { type: { type: "string" } },
      },
    },
    automation: {
      type: "object",
      required: ["id", "version"],
      properties: {
        id: ID,
        version: { anyOf: [ID, { type: "integer", minimum: 0 }] },
      },
    },
    tenant: ID,
    trigger: { type: "object" },
    binding: {
      type: "object",
      properties: {
        connector: ID,
        tools: { type: "array", items: ID, maxItems: 64 },
      },
    },
    resource: {
      type: "object",
      required: ["type", "id"],
      properties: { type: ID, id: ID },
    },
  },
  anyOf: [
    { required: ["scope"], properties: { scope: true } },
    {
      required: ["authorization_details"],
      properties: { authorization_details: true },
    },
  ],
  $defs: {
    act: {
      description:
        "RFC 8693 act: the party running the work; at most 8 nested levels.",
      type: "object",
      required: ["sub"],
      properties: { sub: ID, kind: ID, act: { $ref: "#/$defs/act" } },
    },
  },
};

/**
 * `schemas/support-session-v1.json`: the claims of a
 * `vnd.permdock.support-session+jwt`, as `signSupportSession` writes them.
 */
export const SUPPORT_SESSION_SCHEMA: Readonly<Record<string, unknown>> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://permdock.com/schemas/support-session-v1.json",
  title: "PermDock support session",
  description:
    "The claims of a vnd.permdock.support-session+jwt, wire format v1: sub is the viewed principal, act the support actor, jti the session id. exp is after iat, by at most one day.",
  type: "object",
  required: [
    "v",
    "iss",
    "sub",
    "aud",
    "jti",
    "iat",
    "exp",
    "act",
    "tenant",
    "reason",
    "permissions",
  ],
  properties: {
    v: { const: 1 },
    iss: ID,
    sub: ID,
    aud: AUDIENCE,
    jti: ID,
    iat: NUMERIC_DATE,
    exp: NUMERIC_DATE,
    act: {
      type: "object",
      required: ["sub", "kind"],
      additionalProperties: false,
      properties: { sub: ID, kind: { const: "support" } },
    },
    tenant: ID,
    reason: { type: "string", minLength: 1, maxLength: 1000 },
    permissions: { type: "array", items: ID, minItems: 1, maxItems: 64 },
    approved_by: ID,
    reference: ID,
  },
};
