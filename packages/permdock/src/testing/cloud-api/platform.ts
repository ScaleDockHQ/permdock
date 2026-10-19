import { POLICY_NOT_PUBLISHED } from "../../cli/cloud/problem-types.ts";

export { POLICY_NOT_PUBLISHED };

type Node = Readonly<Record<string, unknown>>;

const CATALOG = "https://permdock.com/schemas/catalog-v1.json";
const MANIFEST = "https://permdock.com/schemas/supabase-manifest-v1.json";
export const PUSHED_POLICY =
  "https://permdock.com/schemas/pushed-policy-v1.json";
const OAUTH_FORM = "application/x-www-form-urlencoded";

/** The scopes the platform issuer grants a person's login. */
export const PLATFORM_SCOPES: Readonly<Record<string, string>> = {
  "projects:read": "List and read the projects the person belongs to",
  "policy:read": "Read a project's pushed catalog, manifest and policy",
  "catalog:write": "Push a catalog and policy with permdock cloud push",
};

const ref = (name: string): Node => ({ $ref: `#/components/schemas/${name}` });

const RATE_LIMIT_HEADERS: Node = {
  RateLimit: {
    description:
      'Remaining quota per policy, draft-ietf-httpapi-ratelimit-headers-11 (`"read";r=59;t=30`)',
    schema: { type: "string" },
  },
  "RateLimit-Policy": {
    description:
      'The quota policy, draft-ietf-httpapi-ratelimit-headers-11 (`"read";q=60;w=60`)',
    schema: { type: "string" },
  },
};

const limited = (description: string, schema: Node): Node => ({
  description,
  headers: RATE_LIMIT_HEADERS,
  content: { "application/json": { schema } },
});

const problem = (description: string, headers?: Node): Node => ({
  description,
  ...(headers === undefined ? {} : { headers }),
  content: { "application/problem+json": { schema: ref("Problem") } },
});

const oauthJson = (description: string, schema: Node): Node => ({
  description,
  content: { "application/json": { schema } },
});

const TOO_MANY = problem("Rate limited; retry after Retry-After seconds", {
  ...RATE_LIMIT_HEADERS,
  "Retry-After": {
    description: "Seconds to wait (RFC 9110)",
    schema: { type: "string" },
  },
});

const READ_SECURITY = (scope: string): readonly Node[] => [
  { platform: [scope] },
  { cloudToken: [] },
];

const read = (
  scope: string,
  summary: string,
  responses: Readonly<Record<string, Node>>,
): Node => ({
  get: {
    security: READ_SECURITY(scope),
    summary,
    responses: {
      ...responses,
      "401": problem("Missing, expired or revoked token"),
      "403": problem(
        "The token may not read this project; a PERMDOCK_CLOUD_TOKEN reads only its own environment",
      ),
      "429": TOO_MANY,
    },
  },
});

export const PLATFORM_SCHEMAS: Readonly<Record<string, Node>> = {
  AuthorizationServerMetadata: {
    type: "object",
    description: "RFC 8414 metadata of the platform issuer",
    required: [
      "issuer",
      "authorization_endpoint",
      "token_endpoint",
      "device_authorization_endpoint",
      "revocation_endpoint",
      "registration_endpoint",
      "scopes_supported",
      "code_challenge_methods_supported",
    ],
    properties: {
      issuer: { type: "string" },
      authorization_endpoint: { type: "string" },
      device_authorization_endpoint: { type: "string" },
      token_endpoint: { type: "string" },
      revocation_endpoint: { type: "string" },
      registration_endpoint: { type: "string" },
      scopes_supported: {
        type: "array",
        items: { type: "string" },
        contains: { const: "policy:read" },
      },
      code_challenge_methods_supported: {
        type: "array",
        items: { const: "S256" },
        minItems: 1,
      },
      grant_types_supported: { type: "array", items: { type: "string" } },
      response_types_supported: { type: "array", items: { type: "string" } },
      token_endpoint_auth_methods_supported: {
        type: "array",
        items: { type: "string" },
      },
    },
  },
  ClientRegistration: {
    type: "object",
    description: "RFC 7591 client information response",
    required: ["client_id", "redirect_uris"],
    properties: {
      client_id: { type: "string", minLength: 1 },
      client_id_issued_at: { type: "integer" },
      redirect_uris: { type: "array", items: { type: "string" } },
      token_endpoint_auth_method: { type: "string" },
      grant_types: { type: "array", items: { type: "string" } },
      client_name: { type: "string" },
      scope: { type: "string" },
    },
  },
  Project: {
    type: "object",
    description:
      "A Cloud project. A project is one environment: `id` is the `{env}` of /v1/environments/{env}.",
    required: ["id", "name", "environment"],
    properties: {
      id: { type: "string", minLength: 1 },
      name: { type: "string" },
      environment: { type: "string", minLength: 1 },
      issuer: {
        type: "string",
        description: "The environment's own issuer for app tokens",
      },
      catalog: {
        type: "object",
        required: ["version", "fingerprint"],
        properties: {
          version: { type: "integer", minimum: 1 },
          fingerprint: { type: "string" },
        },
      },
    },
  },
  ProjectPolicy: {
    type: "object",
    description:
      "What the project's last cloud push sent, with JSON member order kept as pushed, so permdock cloud pull writes the bytes the offline commands write.",
    required: [
      "v",
      "project",
      "version",
      "fingerprint",
      "permdockVersion",
      "catalog",
    ],
    properties: {
      v: { const: 1 },
      project: { type: "string", minLength: 1 },
      version: { type: "integer", minimum: 1 },
      fingerprint: {
        type: "string",
        description: "catalogFingerprint(catalog); equals catalog.fingerprint",
      },
      permdockVersion: {
        type: "string",
        description: "The permdock version that pushed",
      },
      catalog: { $ref: CATALOG },
      manifest: { $ref: MANIFEST },
      policy: { $ref: PUSHED_POLICY },
    },
  },
};

const PROJECT_ID = {
  name: "id",
  in: "path",
  required: true,
  description: "The project id, the same id as its environment",
  schema: { type: "string", minLength: 1 },
};

/** Routes of the platform issuer and its read API; they sit at the API root, outside /v1/environments/{env}. */
export const PLATFORM_PATHS: Readonly<Record<string, Node>> = {
  "/.well-known/oauth-authorization-server": {
    get: {
      security: [],
      summary:
        "RFC 8414 metadata of the platform issuer. For the issuer https://permdock.com/api it is served at https://permdock.com/.well-known/oauth-authorization-server/api (section 3.1) and here.",
      responses: {
        "200": oauthJson("The metadata", ref("AuthorizationServerMetadata")),
      },
    },
  },
  "/oauth/authorize": {
    get: {
      security: [],
      summary:
        "Authorization code with PKCE S256 for public clients, including the RFC 8252 loopback redirect http://127.0.0.1:{port}/callback",
      parameters: [
        ...["response_type", "client_id", "redirect_uri", "code_challenge"].map(
          (name) => ({
            name,
            in: "query",
            required: true,
            schema: { type: "string" },
          }),
        ),
        {
          name: "code_challenge_method",
          in: "query",
          required: true,
          schema: { const: "S256" },
        },
        { name: "state", in: "query", schema: { type: "string" } },
        { name: "scope", in: "query", schema: { type: "string" } },
      ],
      responses: {
        "302": { description: "Redirect to the client with a code" },
        "400": oauthJson(
          "invalid_request, including plain PKCE",
          ref("OAuthError"),
        ),
      },
    },
  },
  "/oauth/device_authorization": {
    post: {
      security: [{ publicClient: [] }],
      summary: "RFC 8628 device authorization for permdock login",
      requestBody: {
        required: true,
        content: {
          [OAUTH_FORM]: {
            schema: { type: "object", required: ["client_id"] },
          },
        },
      },
      responses: {
        "200": oauthJson("The codes", {
          type: "object",
          required: [
            "device_code",
            "user_code",
            "verification_uri",
            "expires_in",
          ],
          properties: {
            device_code: { type: "string" },
            user_code: { type: "string" },
            verification_uri: { type: "string" },
            verification_uri_complete: { type: "string" },
            expires_in: { type: "integer" },
            interval: { type: "integer" },
          },
        }),
        "400": oauthJson(
          "invalid_request or invalid_client",
          ref("OAuthError"),
        ),
      },
    },
  },
  "/oauth/token": {
    post: {
      security: [{ publicClient: [] }],
      summary:
        "authorization_code with code_verifier, device_code and refresh_token for public clients",
      requestBody: {
        required: true,
        content: {
          [OAUTH_FORM]: {
            schema: {
              type: "object",
              required: ["grant_type"],
              properties: {
                grant_type: {
                  enum: [
                    "authorization_code",
                    "urn:ietf:params:oauth:grant-type:device_code",
                    "refresh_token",
                  ],
                },
              },
            },
          },
        },
      },
      responses: {
        "200": oauthJson("The tokens", ref("TokenResponse")),
        "400": oauthJson("An RFC 6749 or RFC 8628 error", ref("OAuthError")),
      },
    },
  },
  "/oauth/revoke": {
    post: {
      security: [{ publicClient: [] }],
      summary:
        "RFC 7009 revocation; permdock logout sends the refresh token. An unknown token also answers 200.",
      requestBody: {
        required: true,
        content: {
          [OAUTH_FORM]: {
            schema: {
              type: "object",
              required: ["token"],
              properties: {
                token: { type: "string" },
                token_type_hint: {
                  enum: ["access_token", "refresh_token"],
                },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Revoked, or the token was not known" },
        "400": oauthJson("invalid_request", ref("OAuthError")),
      },
    },
  },
  "/oauth/register": {
    post: {
      security: [],
      summary:
        "RFC 7591 dynamic client registration for MCP clients of https://permdock.com/mcp: public clients with loopback or https redirect URIs",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["redirect_uris"],
              properties: {
                redirect_uris: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                },
                token_endpoint_auth_method: { const: "none" },
                client_name: { type: "string" },
                scope: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "201": oauthJson("The registered client", ref("ClientRegistration")),
        "400": oauthJson(
          "invalid_redirect_uri or invalid_client_metadata",
          ref("OAuthError"),
        ),
      },
    },
  },
  "/v1/projects": read("projects:read", "The projects the token reads", {
    "200": limited("The projects", {
      type: "object",
      required: ["items"],
      properties: {
        items: { type: "array", items: ref("Project") },
        next: { type: "string" },
      },
    }),
  }),
  "/v1/projects/{id}": {
    parameters: [PROJECT_ID],
    ...read("projects:read", "One project", {
      "200": limited("The project", ref("Project")),
      "404": problem("No such project"),
    }),
  },
  "/v1/projects/{id}/policy": {
    parameters: [PROJECT_ID],
    ...read(
      "policy:read",
      "The pushed catalog, manifest and policy, for permdock cloud pull and rls generate --project",
      {
        "200": limited("The pushed policy", ref("ProjectPolicy")),
        "404": problem(
          `No such project, or \`type\` ${POLICY_NOT_PUBLISHED}: nothing pushed yet`,
        ),
      },
    ),
  },
};

export const PLATFORM_SECURITY_SCHEMES: Readonly<Record<string, Node>> = {
  platform: {
    type: "oauth2",
    description:
      "A person's login at the platform issuer https://permdock.com/api: permdock login (device flow, RFC 8628, or the RFC 8252 loopback with PKCE) or an MCP client registered with RFC 7591.",
    flows: {
      authorizationCode: {
        authorizationUrl: "https://permdock.com/api/oauth/authorize",
        tokenUrl: "https://permdock.com/api/oauth/token",
        refreshUrl: "https://permdock.com/api/oauth/token",
        scopes: PLATFORM_SCOPES,
      },
    },
  },
  cloudToken: {
    type: "http",
    scheme: "bearer",
    description:
      "PERMDOCK_CLOUD_TOKEN: a read-only Cloud key pinned to one environment, for CI. It reads that project and its policy, and nothing else.",
  },
};
