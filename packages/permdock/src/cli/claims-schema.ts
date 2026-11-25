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
        memberships: {
          description:
            "The membership entries: an array of entries, or the compact object the hook writes (core/membership-claim.ts).",
          oneOf: [
            { type: "array", items: { $ref: "#/$defs/membership" } },
            {
              type: "object",
              additionalProperties: false,
              minProperties: 1,
              properties: {
                s: {
                  description: "The scopes the rows in e use, by index.",
                  type: "array",
                  items: { type: "string" },
                },
                r: {
                  description: "The roles the rows in e use, by index.",
                  type: "array",
                  items: { type: "string" },
                },
                v: {
                  description: "The via labels the rows in e use, by index.",
                  type: "array",
                  items: { type: "string" },
                },
                e: {
                  description:
                    "One [scope index, id, via index or -1, ...role indexes] row per plain entry. A UUID id is its 22 character base64url form; any other id is = and the text.",
                  type: "array",
                  items: {
                    type: "array",
                    minItems: 3,
                    items: { type: ["string", "integer"] },
                  },
                },
                o: {
                  description:
                    "Entries that carry more than a scope, an id, roles and a via, as objects.",
                  type: "array",
                  items: { $ref: "#/$defs/membership" },
                },
              },
            },
          ],
        },
        memberships_truncated: {
          description: "true when the size budget cut memberships or attrs.",
          type: "boolean",
        },
        suspended_in: {
          description:
            "The ids of the tenants where the user is a member and the tenant is suspended (rls.suspension.scopes.<root>). Written outside the memberships budget and cut at 16 ids; the memberships of a suspended tenant are not in memberships.",
          type: "array",
          items: { type: "string" },
        },
        team_ids: {
          description:
            "The uuid of every team the user belongs to (supabase.hook.teams). Omitted when the team budget is exceeded.",
          type: "array",
          items: { type: "string" },
        },
        team_ids_truncated: {
          description:
            "true when team_ids was omitted because it did not fit the shared budget. memberships_truncated is not set by team rows.",
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
        expires_at: {
          description: "NumericDate (RFC 7519): seconds since the epoch.",
          type: "number",
        },
        granted_by: { type: "string" },
        reason: { type: "string" },
        member: {
          description: "The subgroup a membership source's group fills.",
          type: "object",
          required: ["group"],
          properties: { group: { type: "string", minLength: 1 } },
        },
        managed_by: { const: "idp" },
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
