import { freezeDeep } from "../../core/freeze.ts";

type Node = Readonly<Record<string, unknown>>;

const ENV = "/v1/environments/{env}";
const COMPACT_JWS = String.raw`^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$`;
const APPROVAL_REQUEST =
  "https://permdock.com/schemas/approval-request-v1.json";
const CONNECTOR = "https://permdock.com/schemas/connector-v1.json";

const ref = (name: string): Node => ({ $ref: `#/components/schemas/${name}` });

const problem = (description: string): Node => ({
  description,
  content: { "application/problem+json": { schema: ref("Problem") } },
});

const json = (description: string, schema: Node): Node => ({
  description,
  content: { "application/json": { schema } },
});

const jwt = (description: string): Node => ({
  description,
  content: { "application/jwt": { schema: ref("CompactJws") } },
});

const empty = (description: string): Node => ({ description });

const body = (schema: Node, type = "application/json"): Node => ({
  required: true,
  content: { [type]: { schema } },
});

const UNAUTHORISED = problem("Missing or unknown key");
const FORBIDDEN = problem("A key of another kind");

type Operation = {
  readonly summary: string;
  readonly security?: readonly Node[];
  readonly parameters?: readonly Node[];
  readonly requestBody?: Node;
  readonly responses: Readonly<Record<string, Node>>;
};

const keyed =
  (scheme: "client" | "admin" | "export") =>
  (operation: Operation): Node => ({
    security: [{ [scheme]: [] }],
    ...operation,
    responses: {
      ...operation.responses,
      "401": UNAUTHORISED,
      "403": FORBIDDEN,
    },
  });

const client = keyed("client");
const admin = keyed("admin");

const open = (operation: Operation): Node => ({ security: [], ...operation });

const header = (name: string, description: string): Node => ({
  name,
  in: "header",
  required: true,
  description,
  schema: { type: "string", minLength: 1 },
});

const APPROVAL_TOKEN = header(
  "PermDock-Approval",
  "The approval token; never in the URL",
);

const ID = { $ref: "#/components/parameters/id" };

const items = (schema: Node): Node => ({
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: schema },
    next: { type: "string" },
  },
});

function crud(
  name: string,
  schema: Node,
  input: Node,
): Readonly<Record<string, Node>> {
  return {
    [`${ENV}/${name}`]: {
      get: admin({
        summary: `List ${name}`,
        responses: { "200": json("The list", items(schema)) },
      }),
      post: admin({
        summary: `Create one of ${name}`,
        requestBody: body(input),
        responses: {
          "201": json("Stored", schema),
          "400": problem("Not a valid body"),
        },
      }),
    },
    [`${ENV}/${name}/{id}`]: {
      parameters: [ID],
      get: admin({
        summary: `Read one of ${name}`,
        responses: {
          "200": json("The item", schema),
          "404": problem("Unknown id"),
        },
      }),
      delete: admin({
        summary: `Remove one of ${name}`,
        responses: { "204": empty("Removed"), "404": problem("Unknown id") },
      }),
    },
  };
}

const withId = (schema: Node): Node => ({
  allOf: [
    schema,
    {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  ],
});

const TRUSTED_ISSUER: Node = {
  type: "object",
  required: ["issuer", "audiences", "purposes"],
  properties: {
    id: { type: "string" },
    issuer: { type: "string", pattern: "^https://" },
    jwks_uri: { type: "string", pattern: "^https://" },
    discovery: { type: "string", pattern: "^https://" },
    audiences: { type: "array", minItems: 1, items: { type: "string" } },
    purposes: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { enum: ["approver", "subject", "token-exchange"] },
    },
  },
  oneOf: [
    { required: ["jwks_uri"], properties: { jwks_uri: true } },
    { required: ["discovery"], properties: { discovery: true } },
  ],
};

const TRUSTED_PEP: Node = {
  type: "object",
  properties: {
    id: { type: "string" },
    vercel: {
      type: "object",
      required: ["team_id"],
      additionalProperties: false,
      properties: {
        team_id: { type: "string", minLength: 1 },
        project_id: { type: "string", minLength: 1 },
        environment: { enum: ["production", "preview", "development"] },
      },
    },
    client_id: { type: "string", minLength: 1 },
  },
  oneOf: [
    { required: ["vercel"], properties: { vercel: true } },
    { required: ["client_id"], properties: { client_id: true } },
  ],
};

const APPROVER_GROUP: Node = {
  type: "object",
  required: ["name", "members"],
  properties: {
    id: { type: "string" },
    name: { type: "string", minLength: 1 },
    members: { type: "array", items: { type: "string", minLength: 1 } },
  },
};

const ASSIGNMENT: Node = {
  type: "object",
  required: ["tenant", "role"],
  properties: {
    id: { type: "string" },
    principal: { type: "string" },
    group: { type: "string" },
    tenant: { type: "string" },
    team: { type: "string" },
    role: { type: "string", minLength: 1 },
  },
  oneOf: [
    { required: ["principal"], properties: { principal: true } },
    { required: ["group"], properties: { group: true } },
  ],
};

const SCHEMAS: Readonly<Record<string, Node>> = {
  Problem: {
    type: "object",
    description: "RFC 9457 Problem Details",
    required: ["type", "title", "status"],
    properties: {
      type: { type: "string" },
      title: { type: "string" },
      status: { type: "integer", minimum: 400, maximum: 599 },
      detail: { type: "string" },
      instance: { type: "string" },
      code: { type: "string" },
      reason: { type: "string" },
    },
  },
  CompactJws: { type: "string", pattern: COMPACT_JWS },
  ApprovalRequest: { $ref: APPROVAL_REQUEST },
  ApprovalPage: items({ $ref: APPROVAL_REQUEST }),
  Verdict: {
    type: "object",
    required: ["status", "by"],
    properties: {
      status: { enum: ["approved", "rejected"] },
      by: { type: "object" },
      note: { type: "string" },
    },
  },
  CatalogPush: {
    oneOf: [
      {
        type: "object",
        required: ["version", "fingerprint", "findings"],
        properties: {
          version: { type: "integer", minimum: 1 },
          fingerprint: { type: "string", minLength: 1 },
          findings: { type: "array", items: { type: "object" } },
        },
      },
      {
        type: "object",
        required: ["version", "fingerprint", "unchanged"],
        properties: {
          version: { type: "integer", minimum: 1 },
          fingerprint: { type: "string", minLength: 1 },
          unchanged: { const: true },
        },
      },
    ],
  },
  HostedGrant: {
    type: "object",
    required: ["permission", "to"],
    properties: {
      id: { type: "string" },
      permission: { type: "string", minLength: 1 },
      to: { type: "object" },
    },
  },
  Connector: { $ref: CONNECTOR },
  TrustedIssuer: TRUSTED_ISSUER,
  TrustedPep: TRUSTED_PEP,
  ApproverGroup: APPROVER_GROUP,
  Assignment: ASSIGNMENT,
  Created: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", minLength: 1 } },
  },
  Jwks: {
    type: "object",
    required: ["keys"],
    properties: { keys: { type: "array", items: { type: "object" } } },
  },
  Metadata: { type: "object", additionalProperties: true },
  TokenResponse: {
    type: "object",
    required: ["access_token", "token_type", "expires_in"],
    properties: {
      access_token: { type: "string" },
      issued_token_type: { type: "string" },
      token_type: { const: "Bearer" },
      expires_in: { type: "integer", minimum: 1 },
      refresh_token: { type: "string" },
    },
  },
  OAuthError: {
    type: "object",
    required: ["error"],
    properties: {
      error: { type: "string" },
      error_description: { type: "string" },
    },
  },
  SsfStream: {
    type: "object",
    required: ["stream_id"],
    properties: { stream_id: { type: "string" } },
  },
  SetPoll: {
    type: "object",
    required: ["sets"],
    properties: {
      sets: { type: "object", additionalProperties: ref("CompactJws") },
      moreAvailable: { type: "boolean" },
    },
  },
};

const APPROVALS: Readonly<Record<string, Node>> = {
  [`${ENV}/approvals`]: {
    post: client({
      summary: "approvals.create",
      requestBody: body(ref("ApprovalRequest")),
      responses: {
        "200": json(
          "The record already stored for this token",
          ref("ApprovalRequest"),
        ),
        "201": json("Stored", ref("ApprovalRequest")),
        "400": problem("Not a v1 approval request"),
      },
    }),
    get: client({
      summary: "approvals.list",
      parameters: [
        ...[
          "status",
          "principalId",
          "actorId",
          "tenant",
          "session",
          "cursor",
        ].map((name): Node => ({
          name,
          in: "query",
          schema: { type: "string" },
        })),
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1 } },
      ],
      responses: { "200": json("One page", ref("ApprovalPage")) },
    }),
  },
  [`${ENV}/approvals/by-token`]: {
    get: client({
      summary: "approvals.get",
      parameters: [APPROVAL_TOKEN],
      responses: {
        "200": json("The record", ref("ApprovalRequest")),
        "404": problem("Unknown token"),
      },
    }),
  },
  [`${ENV}/approvals/{id}`]: {
    parameters: [ID],
    get: client({
      summary: "approvals.getById",
      responses: {
        "200": json("The record", ref("ApprovalRequest")),
        "404": problem("Unknown id"),
      },
    }),
  },
  [`${ENV}/approvals/by-token/resolve`]: {
    post: client({
      summary: "approvals.resolve",
      parameters: [
        APPROVAL_TOKEN,
        {
          ...header(
            "PermDock-Approver",
            "The approver at+jwt; absent only for a system rejection",
          ),
          required: false,
        },
        { name: "If-Match", in: "header", schema: { type: "string" } },
      ],
      requestBody: body(ref("Verdict")),
      responses: {
        "200": json("The resolved record", ref("ApprovalRequest")),
        "404": problem("approval-not-found"),
        "409": problem("Not pending, or a stale ETag"),
        "410": problem("Expired"),
      },
    }),
  },
  [`${ENV}/approvals/by-token/consume`]: {
    post: client({
      summary: "approvals.consume",
      parameters: [APPROVAL_TOKEN],
      responses: {
        "200": json(
          "The approved record with consumedAt",
          ref("ApprovalRequest"),
        ),
        "409": problem("Not approved, already consumed or expired"),
      },
    }),
  },
  [`${ENV}/approvals/expire`]: {
    post: client({
      summary: "approvals.expire",
      responses: {
        "200": json("Requests expired", {
          type: "object",
          required: ["expired"],
          properties: { expired: { type: "integer", minimum: 0 } },
        }),
      },
    }),
  },
  [`${ENV}/approvals/cancel`]: {
    post: client({
      summary: "approvals.cancel",
      requestBody: body({
        type: "object",
        required: ["filter", "by"],
        properties: {
          filter: { type: "object" },
          by: { type: "string", minLength: 1 },
          note: { type: "string" },
        },
      }),
      responses: {
        "200": json("Requests cancelled", {
          type: "object",
          required: ["cancelled"],
          properties: { cancelled: { type: "integer", minimum: 0 } },
        }),
      },
    }),
  },
};

const RUNTIME: Readonly<Record<string, Node>> = {
  [`${ENV}/decisions`]: {
    post: client({
      summary: "sink.write and sink.flush",
      requestBody: body(
        { type: "array", items: { type: "object" } },
        "application/cloudevents-batch+json",
      ),
      responses: {
        "202": empty("Accepted"),
        "400": problem("Not a CloudEvents batch"),
      },
    }),
  },
  [`${ENV}/snapshot`]: {
    get: client({
      summary: "snapshotsFor(token).get",
      parameters: [
        header(
          "PermDock-Subject",
          "An at+jwt naming the subject, exp at most five minutes after iat",
        ),
      ],
      responses: {
        "200": jwt("A vnd.permdock.snapshot+jwt"),
      },
    }),
  },
  [`${ENV}/catalog`]: {
    post: client({
      summary: "catalog.push and permdock cloud push",
      requestBody: body({
        type: "object",
        required: ["fingerprint", "catalog"],
        properties: {
          fingerprint: { type: "string", minLength: 1 },
          catalog: { type: "object" },
          policy: { type: "object" },
        },
      }),
      responses: {
        "200": json("The fingerprint is already published", ref("CatalogPush")),
        "201": json("A new version and its drift findings", ref("CatalogPush")),
        "400": problem(
          "Not a catalog, or a fingerprint that does not match it",
        ),
      },
    }),
    get: client({
      summary: "The latest catalog",
      responses: {
        "200": json("The catalog", { type: "object" }),
        "404": problem("Nothing pushed yet"),
      },
    }),
  },
  [`${ENV}/catalog/versions`]: {
    get: client({
      summary: "Catalog versions",
      responses: {
        "200": json(
          "Versions, newest first",
          items({
            type: "object",
            required: ["version", "fingerprint"],
            properties: {
              version: { type: "integer", minimum: 1 },
              fingerprint: { type: "string" },
            },
          }),
        ),
      },
    }),
  },
  [`${ENV}/deliveries`]: {
    post: client({
      summary: "cloudDeliveryTransport",
      parameters: [header("Idempotency-Key", "The router's per-recipient key")],
      requestBody: body({
        type: "object",
        required: ["channel", "delivery", "target", "message"],
        properties: {
          channel: { type: "string" },
          delivery: { type: "string" },
          target: { type: "object", required: ["address", "permission"] },
          message: { type: "object" },
        },
      }),
      responses: {
        "202": json("Accepted", ref("Created")),
        "400": problem("invalid-message"),
        "409": problem("A delivery with this key is in flight"),
        "422": problem("invalid-message"),
        "429": problem("rate-limited"),
      },
    }),
  },
  [`${ENV}/sign`]: {
    post: client({
      summary: "cloudSigner",
      requestBody: body({
        type: "object",
        required: ["typ", "claims", "aud"],
        properties: {
          typ: { type: "string" },
          claims: { type: "object" },
          aud: {
            anyOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
          },
          exp: { type: "integer" },
          iat: { type: "integer" },
          jti: { type: "string" },
        },
      }),
      responses: {
        "200": jwt("The compact JWS of the requested typ"),
        "400": problem("Missing audience or claims"),
        "422": problem("A typ the client key may not sign"),
      },
    }),
  },
  [`${ENV}/policy`]: {
    get: client({
      summary: "policies.refresh",
      responses: {
        "200": jwt("A vnd.permdock.policy+jwt"),
        "404": problem("No hosted grants"),
      },
    }),
  },
};

const AUTHORING: Readonly<Record<string, Node>> = {
  [`${ENV}/hosted-grants`]: {
    get: admin({
      summary: "List hosted grants",
      responses: { "200": json("The grants", items(ref("HostedGrant"))) },
    }),
    post: admin({
      summary: "Author a hosted grant",
      requestBody: body(ref("HostedGrant")),
      responses: {
        "201": json("The stored grant", withId(ref("HostedGrant"))),
        "422": problem(
          "A grant mergeHostedGrants would drop; reason names why",
        ),
      },
    }),
  },
  [`${ENV}/hosted-grants/{id}`]: {
    parameters: [ID],
    delete: admin({
      summary: "Remove a hosted grant",
      responses: { "204": empty("Removed"), "404": problem("Unknown id") },
    }),
  },
  [`${ENV}/directory/principals`]: {
    get: admin({
      summary: "List principals",
      responses: { "200": json("The list", items({ type: "object" })) },
    }),
    post: admin({
      summary: "Create a principal",
      requestBody: body({ type: "object", required: ["subject"] }),
      responses: { "201": json("Created", ref("Created")) },
    }),
  },
  [`${ENV}/directory/groups`]: {
    get: admin({
      summary: "List groups",
      responses: { "200": json("The list", items({ type: "object" })) },
    }),
    post: admin({
      summary: "Create a group",
      requestBody: body({ type: "object", required: ["name"] }),
      responses: { "201": json("Created", ref("Created")) },
    }),
  },
  ...crud("directory/assignments", ref("Assignment"), ref("Assignment")),
  ...crud("connectors", withId(ref("Connector")), ref("Connector")),
  ...crud(
    "trusted-issuers",
    withId(ref("TrustedIssuer")),
    ref("TrustedIssuer"),
  ),
  ...crud("trusted-peps", withId(ref("TrustedPep")), ref("TrustedPep")),
  ...crud(
    "approver-groups",
    withId(ref("ApproverGroup")),
    ref("ApproverGroup"),
  ),
  [`${ENV}/snapshots/invalidate`]: {
    post: admin({
      summary: "Invalidate edge snapshots and send CAEP session-revoked",
      requestBody: body({
        type: "object",
        required: ["reason"],
        properties: {
          principal: { type: "string" },
          session: { type: "string" },
          tenant: { type: "string" },
          reason: { type: "string", minLength: 1 },
        },
      }),
      responses: { "202": empty("Accepted") },
    }),
  },
  [`${ENV}/export`]: {
    get: keyed("export")({
      summary: "The decision log",
      parameters: [
        {
          name: "format",
          in: "query",
          required: true,
          schema: { enum: ["jws", "ocsf", "csv", "otlp"] },
        },
      ],
      responses: {
        "200": {
          description: "The export",
          content: {
            "application/jwt": { schema: ref("CompactJws") },
            "application/json": { schema: { type: "array" } },
            "text/csv": { schema: { type: "string" } },
          },
        },
      },
    }),
  },
};

const OAUTH_FORM = "application/x-www-form-urlencoded";

const IDENTITY: Readonly<Record<string, Node>> = {
  [`${ENV}/oauth/authorize`]: {
    get: open({
      summary: "Authorization code with PKCE; S256 only",
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
        "302": empty("Redirect to the client with a code"),
        "400": json("invalid_request, including plain PKCE", ref("OAuthError")),
      },
    }),
  },
  [`${ENV}/oauth/device_authorization`]: {
    post: {
      security: [{ oauthClient: [] }, { publicClient: [] }],
      summary: "RFC 8628 device authorization",
      requestBody: body(
        { type: "object", required: ["client_id"] },
        OAUTH_FORM,
      ),
      responses: {
        "200": json("The codes", {
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
        "400": json("invalid_request or invalid_client", ref("OAuthError")),
      },
    },
  },
  [`${ENV}/oauth/token`]: {
    post: {
      security: [{ oauthClient: [] }, { publicClient: [] }],
      summary:
        "authorization_code, device_code, token exchange (confidential only), refresh_token",
      requestBody: body(
        {
          type: "object",
          required: ["grant_type"],
          properties: {
            grant_type: {
              enum: [
                "authorization_code",
                "urn:ietf:params:oauth:grant-type:device_code",
                "urn:ietf:params:oauth:grant-type:token-exchange",
                "refresh_token",
              ],
            },
          },
        },
        OAUTH_FORM,
      ),
      responses: {
        "200": json("The tokens", ref("TokenResponse")),
        "400": json("An RFC 6749 or RFC 8628 error", ref("OAuthError")),
        "401": json("invalid_client", ref("OAuthError")),
      },
    },
  },
  [`${ENV}/.well-known/openid-configuration`]: {
    get: open({
      summary: "Issuer metadata",
      responses: { "200": json("The metadata", ref("Metadata")) },
    }),
  },
  [`${ENV}/.well-known/jwks.json`]: {
    get: open({
      summary: "The environment's JWK Set",
      responses: { "200": json("The JWK Set", ref("Jwks")) },
    }),
  },
};

const ads = (summary: string): Node => ({
  post: {
    security: [{ adsCaller: [] }],
    summary,
    requestBody: body({ type: "object" }),
    responses: {
      "200": json("The AuthZEN response", { type: "object" }),
      "400": problem("Not an AuthZEN request"),
      "401": problem("No verified caller"),
    },
  },
});

const ADS: Readonly<Record<string, Node>> = {
  [`${ENV}/access/v1/evaluation`]: ads("AuthZEN evaluation"),
  [`${ENV}/access/v1/evaluations`]: ads("AuthZEN evaluations"),
  [`${ENV}/access/v1/search/subject`]: ads("AuthZEN subject search"),
  [`${ENV}/access/v1/search/resource`]: ads("AuthZEN resource search"),
  [`${ENV}/access/v1/search/action`]: ads("AuthZEN action search"),
  [`${ENV}/.well-known/authzen-configuration`]: {
    get: open({
      summary: "AuthZEN metadata",
      responses: { "200": json("The metadata", ref("Metadata")) },
    }),
  },
};

const ssf = (operation: Operation): Node => ({
  security: [{ ssfReceiver: [] }],
  ...operation,
});
const STREAM_ID = {
  name: "stream_id",
  in: "query",
  schema: { type: "string" },
};

const SSF: Readonly<Record<string, Node>> = {
  [`${ENV}/ssf/receive/{connector}`]: {
    parameters: [
      {
        name: "connector",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    post: {
      security: [{ connectorStream: [] }],
      summary: "RFC 8935 push into the Cloud's SSF receiver",
      requestBody: body(ref("CompactJws"), "application/secevent+jwt"),
      responses: {
        "202": empty("Accepted"),
        "400": json("An RFC 8935 error", { type: "object", required: ["err"] }),
        "401": empty("Unknown stream credential"),
      },
    },
  },
  [`${ENV}/.well-known/ssf-configuration`]: {
    get: open({
      summary: "SSF transmitter metadata",
      responses: { "200": json("The metadata", ref("Metadata")) },
    }),
  },
  [`${ENV}/ssf/streams`]: {
    get: ssf({
      summary: "Read streams",
      parameters: [STREAM_ID],
      responses: { "200": json("The stream", ref("SsfStream")) },
    }),
    post: ssf({
      summary: "Create a stream",
      requestBody: body({ type: "object" }),
      responses: { "201": json("The stream", ref("SsfStream")) },
    }),
    patch: ssf({
      summary: "Update a stream",
      requestBody: body(ref("SsfStream")),
      responses: { "200": json("The stream", ref("SsfStream")) },
    }),
    delete: ssf({
      summary: "Delete a stream",
      parameters: [STREAM_ID],
      responses: { "204": empty("Deleted") },
    }),
  },
  [`${ENV}/ssf/status`]: {
    get: ssf({
      summary: "A stream's status",
      parameters: [STREAM_ID],
      responses: {
        "200": json("The status", { type: "object", required: ["status"] }),
      },
    }),
    post: ssf({
      summary: "Set a stream's status",
      requestBody: body({ type: "object", required: ["stream_id", "status"] }),
      responses: {
        "200": json("The status", { type: "object", required: ["status"] }),
      },
    }),
  },
  [`${ENV}/ssf/verify`]: {
    post: ssf({
      summary: "Send a verification event",
      requestBody: body({ type: "object", required: ["stream_id"] }),
      responses: { "204": empty("Queued") },
    }),
  },
  [`${ENV}/ssf/poll`]: {
    post: ssf({
      summary: "RFC 8936 poll",
      requestBody: body({ type: "object" }),
      responses: {
        "200": json("Pending SETs", ref("SetPoll")),
        "400": json("invalid_request", { type: "object", required: ["err"] }),
      },
    }),
  },
};

const scim = (summary: string): Node => ({
  security: [{ scimBearer: [] }],
  summary,
  responses: {
    "200": {
      description: "The SCIM response",
      content: { "application/scim+json": { schema: { type: "object" } } },
    },
    "401": empty("Not the connection's bearer"),
  },
});

const SCIM: Readonly<Record<string, Node>> = {
  "/scim/v2/{connection}/{resource}": {
    parameters: [
      {
        name: "connection",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "resource",
        in: "path",
        required: true,
        description: "The SCIM path below the connection",
        schema: { type: "string" },
      },
    ],
    get: scim("SCIM read"),
    post: scim("SCIM create"),
    put: scim("SCIM replace"),
    patch: scim("SCIM patch"),
    delete: scim("SCIM delete"),
  },
};

function withEnv(
  paths: Readonly<Record<string, Node>>,
): Readonly<Record<string, Node>> {
  return Object.fromEntries(
    Object.entries(paths).map(([path, item]) => {
      if (!path.startsWith(ENV)) {
        return [path, item];
      }
      const parameters = Array.isArray(item["parameters"])
        ? item["parameters"]
        : [];
      return [
        path,
        {
          ...item,
          parameters: [{ $ref: "#/components/parameters/env" }, ...parameters],
        },
      ];
    }),
  );
}

const bearer = (description: string): Node => ({
  type: "http",
  scheme: "bearer",
  description,
});

/**
 * `schemas/cloud-api-v1.json`: the PermDock Cloud HTTP API as an OpenAPI 3.1
 * document. The route tables in `adapters/cloud.mdx` and `docs:drift` keep it whole.
 */
export const CLOUD_API_DOCUMENT: Readonly<Record<string, unknown>> = freezeDeep(
  {
    openapi: "3.1.1",
    info: {
      title: "PermDock Cloud API",
      version: "1.0.0",
      description:
        "The routes permdock/cloud calls and the authoring, identity, ADS, SSF and SCIM routes a Cloud implementation serves. Errors are RFC 9457 Problem Details unless the route's own standard says otherwise.",
    },
    jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base",
    servers: [{ url: "https://api.permdock.com" }],
    paths: withEnv({
      ...APPROVALS,
      ...RUNTIME,
      ...AUTHORING,
      ...IDENTITY,
      ...ADS,
      ...SSF,
      ...SCIM,
    }),
    components: {
      parameters: {
        env: {
          name: "env",
          in: "path",
          required: true,
          schema: { type: "string", minLength: 1 },
        },
        id: {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", minLength: 1 },
        },
      },
      schemas: SCHEMAS,
      securitySchemes: {
        client: bearer("The client key (PERMDOCK_CLOUD_KEY)"),
        admin: bearer("The admin key (PERMDOCK_CLOUD_ADMIN_KEY)"),
        export: bearer("An export key"),
        oauthClient: {
          type: "http",
          scheme: "basic",
          description: "A confidential OAuth client, client_secret_basic",
        },
        publicClient: {
          type: "apiKey",
          in: "query",
          name: "client_id",
          description: "A public OAuth client; token exchange refuses it",
        },
        adsCaller: bearer(
          "A Vercel OIDC or client-credentials token for the environment",
        ),
        ssfReceiver: bearer("A receiver's token for its stream"),
        connectorStream: bearer(
          "The caep-transmitter connector's stream credential",
        ),
        scimBearer: bearer("The SCIM connection's bearer"),
      },
    },
  },
);
