import { freezeDeep } from "../core/freeze.ts";

/** The JSON Schema keywords `catalogSchema` uses; `checkSchema` interprets exactly these. */
export type CatalogSchemaNode = {
  readonly $schema?: string;
  readonly $id?: string;
  readonly type?: "object" | "array" | "string" | "boolean" | "integer";
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly pattern?: string;
  readonly minimum?: number;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, CatalogSchemaNode>>;
  readonly additionalProperties?: CatalogSchemaNode;
  readonly items?: CatalogSchemaNode;
  readonly oneOf?: readonly CatalogSchemaNode[];
};

const name = { type: "string", pattern: "^[a-z][a-z0-9_]*$" } as const;
const validity = {
  type: "object",
  properties: {
    from: { type: "integer" },
    until: { type: "integer" },
  },
} as const;
const strings = { type: "array", items: { type: "string" } } as const;
const approval = {
  oneOf: [
    { const: "human" },
    {
      type: "object",
      properties: {
        by: {},
        mode: { enum: ["any", "all", "sequential"] },
        stages: {
          type: "array",
          items: {
            type: "object",
            required: ["by"],
            properties: { by: {}, quorum: { type: "integer", minimum: 1 } },
          },
        },
        distinct: { type: "boolean" },
        staleOn: { const: "resource-change" },
        quorum: { type: "integer", minimum: 1 },
        ttl: { type: "string" },
        escalation: {
          type: "object",
          required: ["after", "to"],
          properties: { after: { type: "string" }, to: {} },
        },
      },
    },
  ],
} as const;

/** `schemas/catalog-v1.json`; a test keeps the two equal. */
export const catalogSchema: CatalogSchemaNode = freezeDeep({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://permdock.com/schemas/catalog-v1.json",
  type: "object",
  required: [
    "$schema",
    "version",
    "generatedAt",
    "generator",
    "resources",
    "permissions",
  ],
  properties: {
    $schema: { type: "string" },
    version: { const: 1 },
    generatedAt: { type: "string" },
    generator: { type: "string" },
    fingerprint: { type: "string" },
    resources: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["id", "schema"],
        properties: {
          id: { type: "string" },
          schema: {},
          definedIn: { type: "string" },
          relations: { type: "object" },
          version: { type: "string" },
          restricted: { type: "string" },
          restrictedStops: strings,
        },
      },
    },
    roles: {
      type: "array",
      items: {
        type: "object",
        required: ["key"],
        properties: {
          key: { type: "string" },
          on: name,
          assignable: { type: "boolean" },
          min: { type: "integer", minimum: 1 },
          max: { type: "integer", minimum: 1 },
          transferOnly: { const: true },
          assigns: strings,
          for: strings,
          exclusiveWith: strings,
          audience: { type: "string" },
          activation: {
            type: "object",
            required: ["justification"],
            properties: {
              maxDuration: { type: "string" },
              justification: { enum: ["required", "optional"] },
              approval: { type: "boolean" },
              assurance: { type: "object" },
            },
          },
          supportAccess: {
            type: "object",
            required: ["actorRequired", "group", "durations"],
            properties: {
              actorRequired: { type: "boolean" },
              group: { type: "string" },
              durations: strings,
            },
          },
        },
      },
    },
    scopes: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "key"],
        properties: {
          name,
          key: { type: "string" },
          within: { type: "string" },
        },
      },
    },
    plans: {
      type: "array",
      items: {
        type: "object",
        required: ["key"],
        properties: { key: { type: "string" } },
      },
    },
    permissions: {
      type: "array",
      items: {
        type: "object",
        required: [
          "key",
          "scope",
          "resource",
          "action",
          "arity",
          "meta",
          "usages",
          "rowConditions",
        ],
        properties: {
          key: { type: "string" },
          scope: { type: "string" },
          resource: { type: "string" },
          action: { type: "string" },
          arity: { enum: ["instance", "collection"] },
          meta: { type: "object" },
          usages: {
            type: "array",
            items: {
              type: "object",
              required: ["file", "line", "call"],
              properties: {
                file: { type: "string" },
                line: { type: "integer", minimum: 0 },
                call: { type: "string" },
              },
            },
          },
          renamedFrom: strings,
          levels: strings,
          hostable: { const: true },
          rowConditions: { type: "boolean" },
          approvals: { type: "array", items: approval },
          breakGlass: {
            type: "object",
            required: ["overrides", "reason", "obligations"],
            properties: {
              overrides: strings,
              purpose: strings,
              reason: { type: "boolean" },
              maxDuration: { type: "string" },
              obligations: strings,
            },
          },
        },
      },
    },
    grants: {
      type: "array",
      items: {
        type: "object",
        required: ["permission", "effect", "role", "to", "scope"],
        properties: {
          permission: { type: "string" },
          effect: { enum: ["allow", "deny"] },
          role: { oneOf: [{ type: "string" }, { const: null }] },
          to: {},
          scope: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                required: ["resource"],
                properties: { resource: { type: "string" } },
              },
            ],
          },
          where: {},
          check: {},
          approval,
          fields: strings,
          validity,
          name: { type: "string" },
          purpose: strings,
          requires: { oneOf: [{ type: "string" }, strings] },
          limit: {
            type: "object",
            required: ["count", "per"],
            properties: {
              count: { type: "integer", minimum: 1 },
              per: { type: "string" },
              mode: { enum: ["hard", "soft"] },
            },
          },
          portable: { const: false },
        },
      },
    },
    delegations: {
      type: "array",
      items: {
        type: "object",
        required: ["from", "to", "permissions"],
        properties: {
          from: {},
          to: {
            type: "object",
            required: ["kind"],
            properties: {
              kind: { type: "string" },
              id: { type: "string" },
              client: { type: "string" },
            },
          },
          permissions: strings,
          validity,
        },
      },
    },
  },
});
