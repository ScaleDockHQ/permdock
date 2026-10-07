/**
 * The PermDock claims of `schemas/supabase-claims-v1.json` (its
 * `permdockClaims` and `membership` definitions), self-contained so
 * `supabase.hook.validate` can inline it into the hook for pg_jsonschema.
 */
export const PERMDOCK_CLAIMS_SCHEMA: Readonly<Record<string, unknown>> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $ref: "#/$defs/permdockClaims",
  $defs: {
    permdockClaims: {
      type: "object",
      properties: {
        user_role: {
          description: "Global roles: one name, a list, or null for none.",
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
            { type: "null" },
          ],
        },
        roles: { type: "array", items: { type: "string" } },
        memberships: { type: "array", items: { $ref: "#/$defs/membership" } },
        memberships_truncated: {
          description: "true when the size budget cut memberships or attrs.",
          type: "boolean",
        },
        tenant_id: {
          description:
            "The active tenant (the default rls.tenantClaim): the canonical text of one instance of the first scope.",
          type: "string",
        },
        attrs: {
          description:
            "Allow-listed server-owned attributes, read as principal.claims.attrs.<key>.",
          type: "object",
        },
        authz_ver: {
          description: "The principal's authorization version.",
          type: "integer",
        },
      },
    },
    membership: {
      type: "object",
      required: ["roles"],
      properties: {
        scope: { type: "string" },
        id: {
          description:
            "Canonical text of the scope instance id (uuid::text for a uuid column); compared exactly, never lower-cased.",
          type: "string",
        },
        within: {
          description:
            "The id of every ancestor scope instance, by scope name.",
          type: "object",
          additionalProperties: { type: "string" },
        },
        on: {
          type: "object",
          required: ["resource", "id"],
          properties: { resource: { type: "string" }, id: { type: "string" } },
        },
        tenant: { type: "string" },
        team: { type: "string" },
        roles: { type: "array", minItems: 1, items: { type: "string" } },
        via: { type: "string" },
        expiresAt: { description: "Seconds since the epoch.", type: "number" },
        grantedBy: { type: "string" },
        reason: { type: "string" },
        member: {
          description: "The subgroup a membership source's group fills.",
          type: "object",
          required: ["group"],
          properties: { group: { type: "string", minLength: 1 } },
        },
        managedBy: { const: "idp" },
        entitlements: { type: "array", items: { type: "string" } },
        keep: {
          description:
            "Set when the instance or an ancestor is suspended: the permission keys the membership still grants.",
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        grants: {
          description:
            "Custom roles in compact form, read by the helpers in jwt mode.",
          type: "object",
        },
      },
      anyOf: [
        { required: ["scope", "id"] },
        { required: ["tenant"] },
        { required: ["team"] },
        { required: ["on"] },
      ],
    },
  },
};
