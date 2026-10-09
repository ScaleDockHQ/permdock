import type { JsonSchemaNode } from "../core/json-schema.ts";

import { freezeDeep } from "../core/freeze.ts";

/** `schemas/supabase-manifest-v1.json`, which `parseSupabaseManifest` checks against; a test keeps the two equal. */
export const supabaseManifestSchema: JsonSchemaNode = freezeDeep({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://permdock.com/schemas/supabase-manifest-v1.json",
  title: "PermDock Supabase hook manifest v1",
  description:
    "What `permdock supabase inspect --json` prints and `--out` writes: the generated hook, the SQL helpers, the claims, the membership sources and the columns that decide them. Fields are only added within v1.",
  type: "object",
  required: [
    "$schema",
    "version",
    "hook",
    "helpers",
    "tenantClaim",
    "budget",
    "claims",
    "authzVersion",
    "memberships",
    "rls",
    "decidingColumns",
    "markers",
  ],
  properties: {
    $schema: {
      const: "https://permdock.com/schemas/supabase-manifest-v1.json",
    },
    version: {
      const: 1,
    },
    hook: {
      type: "object",
      required: ["schema", "function", "out"],
      properties: {
        schema: {
          $ref: "#/$defs/identifier",
        },
        function: {
          const: "custom_access_token_hook",
        },
        out: {
          type: "string",
        },
        before: {
          type: "array",
          items: {
            type: "string",
            pattern: "^[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*$",
          },
        },
      },
    },
    helpers: {
      type: "object",
      required: ["schema", "functions"],
      properties: {
        schema: {
          $ref: "#/$defs/identifier",
        },
        functions: {
          type: "array",
          items: {
            $ref: "#/$defs/helperName",
          },
        },
      },
    },
    tenantClaim: {
      $ref: "#/$defs/identifier",
    },
    budget: {
      type: "object",
      required: ["bytes", "measure"],
      properties: {
        bytes: {
          type: "integer",
          minimum: 1,
        },
        measure: {
          type: "string",
        },
      },
    },
    claims: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "source", "budget"],
        properties: {
          name: {
            $ref: "#/$defs/identifier",
          },
          source: {
            type: "string",
            pattern:
              "^(permdock|[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*)$",
          },
          budget: {
            type: "boolean",
          },
        },
      },
    },
    authzVersion: {
      type: "boolean",
    },
    authzVersionBump: {
      type: "object",
      required: ["schema", "function", "args"],
      properties: {
        schema: {
          $ref: "#/$defs/identifier",
        },
        function: {
          const: "permdock_bump_authz_version_for",
        },
        args: {
          const: "p_users uuid[]",
        },
      },
    },
    memberships: {
      type: "array",
      items: {
        $ref: "#/$defs/membership",
      },
    },
    rls: {
      type: "object",
      required: [
        "schema",
        "mode",
        "tenantClaim",
        "scopes",
        "helpers",
        "memberships",
      ],
      properties: {
        schema: {
          $ref: "#/$defs/identifier",
        },
        mode: {
          enum: ["jwt", "database"],
        },
        tenantClaim: {
          $ref: "#/$defs/identifier",
        },
        scopes: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "type"],
            properties: {
              name: {
                type: "string",
                pattern: "^[a-z][a-z0-9_]*$",
              },
              type: {
                type: "string",
              },
              within: {
                type: "string",
                pattern: "^[a-z][a-z0-9_]*$",
              },
            },
          },
        },
        helpers: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "args", "returns", "execute"],
            properties: {
              name: {
                $ref: "#/$defs/helperName",
              },
              args: {
                type: "string",
              },
              returns: {
                type: "string",
              },
              execute: {
                type: "array",
                items: {
                  enum: ["anon", "authenticated", "supabase_auth_admin"],
                },
              },
            },
          },
        },
        memberships: {
          type: "array",
          items: {
            $ref: "#/$defs/membership",
          },
        },
        customRoles: {
          type: "boolean",
        },
        roles: {
          type: "object",
          required: ["table", "user", "role"],
          additionalProperties: false,
          properties: {
            table: {
              type: "string",
            },
            user: {
              $ref: "#/$defs/column",
            },
            role: {
              oneOf: [
                {
                  $ref: "#/$defs/role",
                },
                {
                  type: "array",
                  minItems: 2,
                  items: {
                    $ref: "#/$defs/role",
                  },
                },
              ],
            },
          },
        },
        suspension: {
          type: "object",
          additionalProperties: false,
          properties: {
            users: {
              $ref: "#/$defs/activeRow",
            },
            scopes: {
              type: "object",
              additionalProperties: {
                $ref: "#/$defs/activeRow",
              },
            },
            memberships: {
              type: "object",
              required: ["keep"],
              additionalProperties: false,
              properties: {
                keep: {
                  description:
                    "The permission keys a membership whose disabledAt column is set still holds.",
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
              },
            },
          },
        },
        assignments: {
          type: "object",
          required: ["tables"],
          additionalProperties: false,
          properties: {
            tables: {
              type: "array",
              items: {
                type: "string",
              },
            },
          },
        },
        apiKeys: {
          type: "object",
          required: ["claim", "scopes", "tenant", "roles", "serviceRoles"],
          additionalProperties: false,
          properties: {
            claim: {
              type: "string",
            },
            scopes: {
              type: "string",
            },
            tenant: {
              type: "string",
            },
            roles: {
              type: "string",
            },
            serviceRoles: {
              type: "array",
              items: {
                type: "string",
              },
            },
          },
        },
      },
    },
    decidingColumns: {
      type: "array",
      items: {
        type: "string",
        pattern:
          "^[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*$",
      },
    },
    markers: {
      type: "object",
      required: ["hook", "grants"],
      properties: {
        hook: {
          const: "v1",
        },
        grants: {
          const: "v1",
        },
      },
    },
    requires: {
      description:
        "The supabase/sdk capability-matrix feature ids the hook, the helpers and subjectFromSupabase depend on, as of the matrix release tag.",
      type: "object",
      required: ["matrix", "capabilities"],
      additionalProperties: false,
      properties: {
        matrix: {
          type: "string",
          pattern: "^capability-matrix-v1\\.[0-9]+\\.[0-9]+$",
        },
        capabilities: {
          type: "array",
          uniqueItems: true,
          items: {
            type: "string",
            pattern: "^[a-z][a-z0-9_]*\\.[a-z0-9_]+\\.[a-z0-9_]+$",
          },
        },
      },
    },
  },
  $defs: {
    membership: {
      type: "object",
      required: ["table", "user", "scope", "id", "role", "columns"],
      properties: {
        table: {
          type: "string",
          pattern: "^[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*$",
        },
        user: {
          $ref: "#/$defs/user",
        },
        scope: {
          $ref: "#/$defs/value",
        },
        id: {
          $ref: "#/$defs/column",
        },
        role: {
          oneOf: [
            {
              $ref: "#/$defs/role",
            },
            {
              type: "array",
              minItems: 2,
              items: {
                $ref: "#/$defs/role",
              },
            },
          ],
        },
        within: {
          oneOf: [
            {
              $ref: "#/$defs/column",
            },
            {
              type: "object",
              required: ["columns"],
              additionalProperties: false,
              properties: {
                columns: {
                  type: "object",
                  additionalProperties: {
                    $ref: "#/$defs/identifier",
                  },
                },
              },
            },
          ],
        },
        via: {
          $ref: "#/$defs/value",
        },
        expiresAt: {
          $ref: "#/$defs/column",
        },
        disabledAt: {
          $ref: "#/$defs/column",
        },
        columns: {
          type: "array",
          items: {
            $ref: "#/$defs/identifier",
          },
        },
      },
    },
    identifier: {
      type: "string",
      pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
    },
    activeRow: {
      type: "object",
      required: ["table", "id"],
      additionalProperties: false,
      properties: {
        table: {
          type: "string",
        },
        id: {
          $ref: "#/$defs/identifier",
        },
        disabledAt: {
          $ref: "#/$defs/identifier",
        },
        status: {
          $ref: "#/$defs/identifier",
        },
        active: {
          type: "array",
          items: {
            type: "string",
          },
        },
        keep: {
          description:
            "A scope only: the permission keys members of a suspended instance still hold.",
          type: "array",
          items: {
            type: "string",
          },
        },
      },
    },
    helperName: {
      type: "string",
      pattern:
        "^(permdock_has(_for)?|permitted_[a-z][a-z0-9_]*_(ids|permission_keys)(_for)?|member_[a-z][a-z0-9_]*_ids(_for)?|permdock_can_assign(_any|_custom_role)?(_for)?|permdock_api_key_allows|permdock_user_id)$",
    },
    column: {
      type: "object",
      required: ["column"],
      additionalProperties: false,
      properties: {
        column: {
          $ref: "#/$defs/identifier",
        },
      },
    },
    role: {
      oneOf: [
        {
          $ref: "#/$defs/value",
        },
        {
          $ref: "#/$defs/through",
        },
      ],
    },
    user: {
      oneOf: [
        {
          $ref: "#/$defs/column",
        },
        {
          $ref: "#/$defs/through",
        },
      ],
    },
    through: {
      type: "object",
      required: ["column", "through"],
      additionalProperties: false,
      properties: {
        column: {
          $ref: "#/$defs/identifier",
        },
        through: {
          type: "object",
          required: ["table", "id", "column"],
          additionalProperties: false,
          properties: {
            table: {
              type: "string",
              pattern: "^[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*$",
            },
            id: {
              $ref: "#/$defs/identifier",
            },
            column: {
              $ref: "#/$defs/identifier",
            },
          },
        },
      },
    },
    value: {
      oneOf: [
        {
          $ref: "#/$defs/column",
        },
        {
          type: "object",
          required: ["value"],
          additionalProperties: false,
          properties: {
            value: {
              oneOf: [
                {
                  type: "string",
                },
                {
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
              ],
            },
          },
        },
      ],
    },
  },
});
