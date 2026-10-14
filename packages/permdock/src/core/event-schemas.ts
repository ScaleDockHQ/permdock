import type { JsonSchemaNode } from "./json-schema.ts";

import { freezeDeep } from "./freeze.ts";
import { RFC3339_PATTERN } from "./time.ts";

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";

/** The URL each event family's schema is published at, and its CloudEvents `dataschema`. */
export const EVENT_SCHEMA_IDS: {
  readonly decision: "https://permdock.com/schemas/decision-event-v1.json";
  readonly directory: "https://permdock.com/schemas/directory-event-v1.json";
  readonly membership: "https://permdock.com/schemas/membership-event-v1.json";
  readonly credential: "https://permdock.com/schemas/credential-event-v1.json";
  readonly access: "https://permdock.com/schemas/access-event-v1.json";
  readonly automation: "https://permdock.com/schemas/automation-event-v1.json";
  readonly catalog: "https://permdock.com/schemas/catalog-event-v1.json";
  readonly delivery: "https://permdock.com/schemas/delivery-event-v1.json";
} = Object.freeze({
  decision: "https://permdock.com/schemas/decision-event-v1.json",
  directory: "https://permdock.com/schemas/directory-event-v1.json",
  membership: "https://permdock.com/schemas/membership-event-v1.json",
  credential: "https://permdock.com/schemas/credential-event-v1.json",
  access: "https://permdock.com/schemas/access-event-v1.json",
  automation: "https://permdock.com/schemas/automation-event-v1.json",
  catalog: "https://permdock.com/schemas/catalog-event-v1.json",
  delivery: "https://permdock.com/schemas/delivery-event-v1.json",
});

/** `format` is an annotation, so `pattern` enforces it. */
const instant: JsonSchemaNode = {
  type: "string",
  format: "date-time",
  pattern: RFC3339_PATTERN,
};
const text: JsonSchemaNode = { type: "string" };
const id: JsonSchemaNode = { type: "string", minLength: 1 };
const strings: JsonSchemaNode = { type: "array", items: text };
const ref: JsonSchemaNode = {
  type: "object",
  required: ["id"],
  properties: { id },
  additionalProperties: false,
};
const actor: JsonSchemaNode = {
  type: "object",
  required: ["id", "kind"],
  properties: { id, kind: text },
  additionalProperties: false,
};
const risk: JsonSchemaNode = { enum: ["low", "medium", "high", "critical"] };
const credentialKind: JsonSchemaNode = { enum: ["user", "service", "feed"] };
const within: JsonSchemaNode = {
  type: "object",
  additionalProperties: text,
};

function family(
  key: keyof typeof EVENT_SCHEMA_IDS,
  title: string,
  description: string,
  node: JsonSchemaNode,
): JsonSchemaNode {
  return freezeDeep({
    $schema: SCHEMA,
    $id: EVENT_SCHEMA_IDS[key],
    title,
    description,
    ...node,
  });
}

export const DECISION_EVENT_SCHEMA: JsonSchemaNode = family(
  "decision",
  "PermDock decision event",
  "A DecisionEvent, wire format v1: the data of com.permdock.decision and com.permdock.approval.* CloudEvents.",
  {
    type: "object",
    required: [
      "type",
      "at",
      "outcome",
      "permission",
      "scope",
      "resource",
      "subject",
      "trusted",
      "call",
    ],
    properties: {
      type: { const: "decision" },
      at: instant,
      outcome: { enum: ["granted", "denied", "approval-required"] },
      permission: id,
      scope: text,
      resource: {
        type: "object",
        required: ["type"],
        properties: { type: text, id: text },
        additionalProperties: false,
      },
      subject: {
        type: "object",
        required: ["principal"],
        properties: {
          principal: {
            type: ["object", "null"],
            required: ["id", "roles"],
            properties: { id, roles: strings, tenant: text },
            additionalProperties: false,
          },
          actor,
          delegation: {
            type: "object",
            properties: {
              scope: text,
              authorization_details: {
                type: "array",
                items: {
                  type: "object",
                  required: ["type"],
                  properties: { type: text },
                },
              },
              access: { type: "array" },
            },
            additionalProperties: false,
          },
          credential: {
            type: "object",
            required: ["id", "kind"],
            properties: { id, kind: credentialKind },
            additionalProperties: false,
          },
          supportSession: {
            type: "object",
            required: ["id"],
            properties: { id },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      tenant: text,
      membership: {
        type: "object",
        required: ["roles"],
        properties: { roles: strings, expiresAt: instant },
      },
      via: { type: ["string", "null"] },
      matched: {
        type: "object",
        required: ["role", "permission"],
        properties: {
          role: { type: ["string", "null"] },
          permission: text,
          name: text,
          meta: { type: "object" },
          to: {},
          hosted: { type: "object" },
          breakGlass: { const: true },
        },
        additionalProperties: false,
      },
      obligations: {
        type: "array",
        items: {
          type: "object",
          required: ["kind"],
          properties: { kind: text },
        },
      },
      purpose: strings,
      reason: text,
      denials: {
        type: "array",
        items: {
          type: "object",
          required: ["role", "reason"],
          properties: {
            role: { type: ["string", "null"] },
            reason: text,
            to: {},
            detail: {},
          },
          additionalProperties: false,
        },
      },
      alternatives: strings,
      token: text,
      trusted: { type: "boolean" },
      call: {
        enum: [
          "can",
          "decide",
          "assert",
          "filter",
          "endpoint",
          "adapter",
          "approval",
          "simulate",
          "explain",
        ],
      },
      adapter: text,
      model: id,
      phase: { enum: ["requested", "resolved", "expired", "cancelled"] },
      counts: {
        type: "object",
        required: ["granted", "denied", "approvalRequired"],
        properties: {
          granted: { type: "integer", minimum: 0 },
          denied: { type: "integer", minimum: 0 },
          approvalRequired: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
);

export const DIRECTORY_EVENT_SCHEMA: JsonSchemaNode = family(
  "directory",
  "PermDock directory event",
  "A DirectoryEvent, wire format v1: the data of com.permdock.directory.* CloudEvents.",
  {
    type: "object",
    required: [
      "type",
      "at",
      "source",
      "operation",
      "tenant",
      "resource",
      "credential",
    ],
    properties: {
      type: { const: "directory" },
      at: instant,
      source: { const: "scim" },
      operation: { enum: ["create", "replace", "patch", "delete"] },
      tenant: id,
      resource: {
        type: "object",
        required: ["type", "id"],
        properties: { type: { enum: ["User", "Group"] }, id },
        additionalProperties: false,
      },
      credential: {
        oneOf: [
          {
            type: "object",
            required: ["kind"],
            properties: { kind: { const: "token" } },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["kind"],
            properties: { kind: { const: "jwt" }, iss: text },
            additionalProperties: false,
          },
        ],
      },
      active: { type: "boolean" },
    },
    additionalProperties: false,
  },
);

export const MEMBERSHIP_EVENT_SCHEMA: JsonSchemaNode = family(
  "membership",
  "PermDock membership event",
  "A MembershipEvent, wire format v1: the data of com.permdock.membership.* CloudEvents.",
  {
    type: "object",
    required: ["type", "at", "source", "operation", "principal", "roles"],
    properties: {
      type: { const: "membership" },
      at: instant,
      source: text,
      operation: { enum: ["added", "removed", "changed"] },
      principal: ref,
      scope: text,
      id: text,
      within,
      via: text,
      expiresAt: instant,
      roles: {
        type: "object",
        required: ["added", "removed"],
        properties: { added: strings, removed: strings },
        additionalProperties: false,
      },
      by: actor,
    },
    additionalProperties: false,
  },
);

export const CREDENTIAL_EVENT_SCHEMA: JsonSchemaNode = family(
  "credential",
  "PermDock credential event",
  "A CredentialEvent, wire format v1: the data of com.permdock.credential.* CloudEvents.",
  {
    type: "object",
    required: ["type", "at", "source", "operation", "credential", "principal"],
    properties: {
      type: { const: "credential" },
      at: instant,
      source: text,
      operation: { enum: ["created", "used", "rotated", "revoked"] },
      credential: {
        type: "object",
        required: ["id", "kind"],
        properties: { id, kind: credentialKind },
        additionalProperties: false,
      },
      principal: ref,
      tenant: text,
      expiresAt: instant,
      by: actor,
      sample: { type: "number", exclusiveMinimum: 0, maximum: 1 },
    },
    additionalProperties: false,
  },
);

export const ACCESS_EVENT_SCHEMA: JsonSchemaNode = family(
  "access",
  "PermDock support access event",
  "An AccessEvent, wire format v1: the data of com.permdock.support-session.* CloudEvents.",
  {
    type: "object",
    required: [
      "type",
      "at",
      "source",
      "operation",
      "tenant",
      "principal",
      "via",
      "roles",
    ],
    properties: {
      type: { const: "access" },
      at: instant,
      source: text,
      operation: { enum: ["started", "ended", "revoked"] },
      tenant: id,
      principal: ref,
      via: text,
      roles: strings,
      member: {
        type: "object",
        required: ["group"],
        properties: { group: text },
        additionalProperties: false,
      },
      expiresAt: instant,
      grantedBy: text,
      reason: text,
      actor,
      session: {
        type: "object",
        required: ["id", "principal"],
        properties: { id, principal: id },
        additionalProperties: false,
      },
      permissions: strings,
    },
    additionalProperties: false,
  },
);

export const AUTOMATION_EVENT_SCHEMA: JsonSchemaNode = family(
  "automation",
  "PermDock automation event",
  "An AutomationEvent, wire format v1: the data of com.permdock.automation.* CloudEvents.",
  {
    type: "object",
    required: [
      "type",
      "at",
      "source",
      "operation",
      "automation",
      "principal",
      "publishedBy",
      "permissions",
    ],
    properties: {
      type: { const: "automation" },
      at: instant,
      source: text,
      operation: { enum: ["published", "changed", "revoked", "run"] },
      automation: {
        type: "object",
        required: ["id", "version", "mode"],
        properties: {
          id,
          version: { type: ["integer", "string"] },
          mode: { enum: ["publisher", "service"] },
          name: text,
        },
        additionalProperties: false,
      },
      principal: ref,
      publishedBy: id,
      tenant: text,
      roles: strings,
      permissions: strings,
      run: ref,
      by: actor,
    },
    additionalProperties: false,
  },
);

export const CATALOG_EVENT_SCHEMA: JsonSchemaNode = family(
  "catalog",
  "PermDock catalog event",
  "The data of com.permdock.catalog.* CloudEvents, wire format v1: a catalog publish or a drift against live hosted grants.",
  {
    type: "object",
    required: ["kind", "fingerprint"],
    properties: {
      kind: { enum: ["publish", "drift"] },
      fingerprint: id,
      previous: text,
      findings: {
        type: "array",
        items: {
          oneOf: [
            {
              type: "object",
              required: ["code", "permission"],
              properties: {
                code: {
                  enum: [
                    "permission-removed",
                    "not-hostable",
                    "grantee-removed",
                    "approval-tightened",
                  ],
                },
                permission: text,
                grant: text,
              },
              additionalProperties: false,
            },
            {
              type: "object",
              required: ["code", "permission", "operation", "previous", "risk"],
              properties: {
                code: { const: "operation-risk-raised" },
                permission: text,
                operation: text,
                previous: risk,
                risk,
              },
              additionalProperties: false,
            },
            {
              type: "object",
              required: ["code", "permission", "operation"],
              properties: {
                code: { const: "operation-approval-removed" },
                permission: text,
                operation: text,
              },
              additionalProperties: false,
            },
          ],
        },
      },
    },
    additionalProperties: false,
  },
);

export const DELIVERY_EVENT_SCHEMA: JsonSchemaNode = family(
  "delivery",
  "PermDock delivery event",
  "A DeliveryEvent, wire format v1: the data of com.permdock.delivery.* CloudEvents.",
  {
    type: "object",
    required: ["type", "at", "source", "operation", "channel", "delivery"],
    properties: {
      type: { const: "delivery" },
      at: instant,
      source: text,
      operation: {
        enum: ["sent", "delivered", "bounced", "complained", "failed"],
      },
      channel: { enum: ["email", "chat", "webhook"] },
      delivery: {
        type: "object",
        required: ["id", "key"],
        properties: { id, key: id },
        additionalProperties: false,
      },
      recipient: {
        type: "object",
        properties: { principal: ref, trusted: { const: true } },
        additionalProperties: false,
      },
      permission: id,
      tenant: text,
      category: {
        enum: ["transactional", "notification", "security", "approval"],
      },
      approval: id,
      provider: {
        type: "object",
        required: ["name"],
        properties: { name: id, id: text },
        additionalProperties: false,
      },
      cause: {
        enum: [
          "denied",
          "unlinked",
          "no-transport",
          "no-message",
          "invalid-recipient",
          "invalid-message",
          "rate-limited",
          "quota-exceeded",
          "unauthorized",
          "unavailable",
          "suppressed",
          "rejected",
        ],
      },
      retryable: { type: "boolean" },
      reason: text,
    },
    additionalProperties: false,
  },
);

/** Every sink event family's schema, keyed by the event's `type`. */
export const SINK_EVENT_SCHEMAS: {
  readonly decision: JsonSchemaNode;
  readonly directory: JsonSchemaNode;
  readonly membership: JsonSchemaNode;
  readonly credential: JsonSchemaNode;
  readonly access: JsonSchemaNode;
  readonly automation: JsonSchemaNode;
  readonly delivery: JsonSchemaNode;
} = Object.freeze({
  decision: DECISION_EVENT_SCHEMA,
  directory: DIRECTORY_EVENT_SCHEMA,
  membership: MEMBERSHIP_EVENT_SCHEMA,
  credential: CREDENTIAL_EVENT_SCHEMA,
  access: ACCESS_EVENT_SCHEMA,
  automation: AUTOMATION_EVENT_SCHEMA,
  delivery: DELIVERY_EVENT_SCHEMA,
});
