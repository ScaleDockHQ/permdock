import { Ajv2020 } from "ajv/dist/2020.js";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/types.ts";
import type { SinkEvent } from "../../src/core/event-types.ts";
import type { PolicyDocument } from "../../src/core/hosted.ts";

import { parseApprovalRequest } from "../../src/approvals/parse-request.ts";
import { signApproval } from "../../src/approvals/signature.ts";
import { validateOpenapi } from "../../src/cli/openapi/schema.ts";
import {
  RUN_TICKET_SCHEMA,
  SUPPORT_SESSION_SCHEMA,
} from "../../src/cli/token-schemas.ts";
import { policyDocumentFromClaims } from "../../src/core/hosted.ts";
import { signPolicyDocument } from "../../src/core/policy-sign.ts";
import { signDecisionBatch } from "../../src/core/sink.ts";
import {
  signSnapshot,
  snapshotClaims,
  snapshotFromClaims,
} from "../../src/core/snapshot-sign.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import { CONNECTOR_SCHEMA } from "../../src/delivery/connector-schema.ts";
import { parseConnector } from "../../src/delivery/connector.ts";
import { joseTokenSigner } from "../../src/jwt/signer.ts";
import { signRunTicket } from "../../src/server/run-ticket.ts";
import { signSupportSession } from "../../src/server/support-session.ts";
import { CLOUD_API_DOCUMENT } from "../../src/testing/cloud-api/document.ts";
import { jwtFixtureTokens } from "../../src/testing/jwt-fixtures.ts";

const SCHEMAS = new URL("../../schemas/", import.meta.url);
const ISSUER = "https://app.example.com";

function json(url: URL): Record<string, unknown> {
  // SAFETY: every file read here is a checked-in JSON object.
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

function claimsOf(token: string): Record<string, unknown> {
  const [, payload = ""] = token.split(".");
  // SAFETY: the payload of a compact JWS this test signed or checked in is a JSON object.
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  formats: { "date-time": true },
});

const OPENAPI_DOCUMENTS = new Set(["cloud-api-v1.json"]);
const files = readdirSync(SCHEMAS).filter(
  (name) => name.endsWith(".json") && !OPENAPI_DOCUMENTS.has(name),
);

function validator(name: string): (value: unknown) => readonly unknown[] {
  const check = ajv.getSchema(`https://permdock.com/schemas/${name}`);
  if (check === undefined) {
    throw new Error(`no schema ${name}`);
  }
  return (value) => (check(value) ? [] : (check.errors ?? []));
}

const signer = joseTokenSigner({
  key: {
    crv: "Ed25519",
    d: "qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4",
    x: "79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ",
    kty: "OKP",
  },
  alg: "Ed25519",
  kid: "2026-09",
  issuer: ISSUER,
  audience: ISSUER,
});

const signedOutputs = json(
  new URL("../testing/fixtures/jwt/signed-outputs.json", import.meta.url),
);

function signedOutput(typ: string): Record<string, unknown> {
  const token = signedOutputs[typ];
  if (typeof token !== "string") {
    throw new TypeError(`no fixture ${typ}`);
  }
  return claimsOf(token);
}

describe("schemas/*.json", () => {
  for (const name of files) {
    ajv.addSchema(json(new URL(name, SCHEMAS)));
  }

  it.each(files)("%s is a 2020-12 schema whose $id names the file", (name) => {
    const schema = json(new URL(name, SCHEMAS));
    expect(schema["$schema"]).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(schema["$id"]).toBe(`https://permdock.com/schemas/${name}`);
    expect(name).toMatch(/^[a-z][a-z0-9-]*-v1\.json$/u);
  });

  it("puts a pattern on every date-time", () => {
    const missing: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        for (const [index, item] of node.entries()) {
          walk(item, `${path}/${index}`);
        }
        return;
      }
      if (node === null || typeof node !== "object") {
        return;
      }
      if (
        "format" in node &&
        node.format === "date-time" &&
        !("pattern" in node)
      ) {
        missing.push(path);
      }
      for (const [key, value] of Object.entries(node)) {
        walk(value, `${path}/${key}`);
      }
    };
    for (const name of files) {
      walk(json(new URL(name, SCHEMAS)), name);
    }
    expect(missing).toStrictEqual([]);
  });
});

describe("snapshot-v1.json", () => {
  const check = validator("snapshot-v1.json");

  it("accepts the snapshot fixture and a snapshot read back from its token", () => {
    expect(
      check(json(new URL("../../fixtures/snapshot.json", import.meta.url))),
    ).toStrictEqual([]);
    const claims = signedOutput("vnd.permdock.snapshot+jwt");
    expect(check(snapshotFromClaims({ iss: ISSUER, ...claims }))).toStrictEqual(
      [],
    );
    expect(
      check(snapshotFromClaims(claimsOf(jwtFixtureTokens.snapshot))),
    ).toStrictEqual([]);
  });

  it("snapshotClaims are the claims signSnapshot signs and snapshotFromClaims reads back", async () => {
    const snapshot = parseSnapshot(
      json(new URL("../../fixtures/snapshot.json", import.meta.url)),
    );
    const claims = snapshotClaims(snapshot);
    const signed = claimsOf(
      await signSnapshot(snapshot, signer, { audience: ISSUER }),
    );
    expect(signed).toMatchObject(claims);
    expect(Object.keys(signed).toSorted()).toStrictEqual(
      [
        ...Object.keys(claims),
        "iss",
        "aud",
        "jti",
        ...(claims.exp === undefined ? ["exp"] : []),
      ].toSorted(),
    );
    expect(snapshotFromClaims(claims)).toMatchObject(claims.snapshot);
  });

  it("rejects numeric times and a scopes list", () => {
    const fixture = json(
      new URL("../../fixtures/snapshot.json", import.meta.url),
    );
    expect(check({ ...fixture, issuedAt: 1_700_000_000 })).not.toStrictEqual(
      [],
    );
    expect(
      check({
        ...fixture,
        subject: { principal: null, context: {}, delegation: { scope: ["a"] } },
      }),
    ).not.toStrictEqual([]);
  });
});

describe("approval-signature-v1.json", () => {
  const check = validator("approval-signature-v1.json");
  const request: ApprovalRequest = {
    v: 1,
    id: "apr_1",
    token: "sha-256:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    permission: "invoice.void",
    scope: "invoice:void",
    resource: { type: "invoice", id: "inv_1" },
    subject: {
      principal: { id: "u1", roles: ["member"] },
      actor: { id: "agent_1", kind: "agent" },
    },
    detail: "invoice.void requires human approval.",
    createdAt: "2026-10-06T09:00:00Z",
    expiresAt: "2026-10-06T10:00:00Z",
    status: "approved",
    resolvedAt: "2026-10-06T09:05:00Z",
    resolvedBy: "u2",
    approvals: [{ by: "u2", at: "2026-10-06T09:05:00Z", stage: 0 }],
  };

  it("accepts what signApproval signs and the checked-in fixtures", async () => {
    const token = await signApproval(request, signer);
    expect(check(claimsOf(token ?? ""))).toStrictEqual([]);
    expect(check(signedOutput("vnd.permdock.approval+jwt"))).toStrictEqual([]);
    expect(check(claimsOf(jwtFixtureTokens.approval))).toStrictEqual([]);
  });

  it("rejects two authorization_details and a numeric approval time", async () => {
    const claims = claimsOf((await signApproval(request, signer)) ?? "");
    const detail = { type: "invoice", actions: ["void"] };
    expect(
      check({ ...claims, authorization_details: [detail, detail] }),
    ).not.toStrictEqual([]);
    expect(
      check({ ...claims, approvals: [{ by: "u2", at: 1 }] }),
    ).not.toStrictEqual([]);
  });
});

describe("capability-v1.json", () => {
  const check = validator("capability-v1.json");
  const claims = signedOutput("vnd.permdock.capability+jwt");

  it("accepts the capability fixture, with or without cnf", () => {
    expect(check(claims)).toStrictEqual([]);
    expect(
      check({
        ...claims,
        cnf: { jkt: "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I" },
      }),
    ).toStrictEqual([]);
  });

  it("rejects a capability without sub, with an id, or with a short jkt", () => {
    const { sub: _sub, ...unnamed } = claims;
    expect(check(unnamed)).not.toStrictEqual([]);
    expect(check({ ...claims, capability: { v: 2 } })).not.toStrictEqual([]);
    expect(check({ ...claims, cnf: { jkt: "short" } })).not.toStrictEqual([]);
  });
});

describe("credential-v1.json", () => {
  const check = validator("credential-v1.json");
  const user = {
    v: 1,
    id: "key_1",
    kind: "user",
    principal: "u1",
    permissions: [{ permission: "post.read" }],
    createdBy: "u1",
    createdAt: "2023-11-14T22:13:20Z",
    expiresAt: "2023-11-15T22:13:20Z",
  };

  it("rejects Unix-second times", () => {
    expect(check({ ...user, createdAt: 1_700_000_000 })).not.toStrictEqual([]);
    expect(check({ ...user, expiresAt: "2023-11-15" })).not.toStrictEqual([]);
  });

  it("accepts user, service and feed credentials", () => {
    expect(check(user)).toStrictEqual([]);
    expect(
      check({
        ...user,
        kind: "service",
        principal: "svc_1",
        tenant: "org_1",
        roles: ["bot"],
      }),
    ).toStrictEqual([]);
    expect(
      check({
        ...user,
        id: "feed_1",
        kind: "feed",
        principal: "feed_1",
        roles: ["viewer"],
        on: { resource: "calendar", id: "cal_1" },
        permissions: [{ permission: "calendar.read", ids: ["cal_1"] }],
      }),
    ).toStrictEqual([]);
  });

  it("rejects a service credential without a tenant and an unknown kind", () => {
    expect(
      check({ ...user, kind: "service", roles: ["bot"] }),
    ).not.toStrictEqual([]);
    expect(check({ ...user, kind: "robot" })).not.toStrictEqual([]);
  });
});

describe("policy-v1.json", () => {
  const check = validator("policy-v1.json");
  const claims = signedOutput("vnd.permdock.policy+jwt");

  it("accepts the policy fixture", () => {
    expect(check(claims)).toStrictEqual([]);
  });

  it("rejects a document without jti or with grants that lack an id", () => {
    const { jti: _jti, ...anonymous } = claims;
    expect(check(anonymous)).not.toStrictEqual([]);
    expect(
      check({
        ...claims,
        policy: {
          v: 1,
          fingerprint: "f",
          catalog: "c",
          grants: [{ permission: "p", to: {} }],
        },
      }),
    ).not.toStrictEqual([]);
  });
});

describe("evidence-export-v1.json", () => {
  const check = validator("evidence-export-v1.json");

  it("accepts what signDecisionBatch signs and the checked-in fixture", async () => {
    // SAFETY: decision-event.json is the checked-in decision event fixture.
    const event = json(
      new URL("../../fixtures/decision-event.json", import.meta.url),
    ) as SinkEvent;
    const token = await signDecisionBatch([event], signer, { source: ISSUER });
    expect(check(claimsOf(token))).toStrictEqual([]);
    expect(check(signedOutput("vnd.permdock.evidence+jwt"))).toStrictEqual([]);
  });

  it("rejects an event without specversion", () => {
    const claims = signedOutput("vnd.permdock.evidence+jwt");
    expect(
      check({
        ...claims,
        events: [{ id: "1", source: ISSUER, type: "t", data: {} }],
      }),
    ).not.toStrictEqual([]);
  });
});

describe("run-v1.json and support-session-v1.json", () => {
  it("match the constants the CLI exports", () => {
    expect(json(new URL("run-v1.json", SCHEMAS))).toStrictEqual(
      RUN_TICKET_SCHEMA,
    );
    expect(json(new URL("support-session-v1.json", SCHEMAS))).toStrictEqual(
      SUPPORT_SESSION_SCHEMA,
    );
  });

  it("accept what signRunTicket signs and reject a ticket with no delegation", async () => {
    const check = validator("run-v1.json");
    const claims = claimsOf(
      await signRunTicket(
        {
          principal: "u_ann",
          kind: "automation",
          actor: { id: "auto_1", kind: "automation", act: { sub: "sched" } },
          delegation: { scopes: ["doc:read"] },
          automation: { id: "auto_1", version: 3 },
          tenant: "o1",
          trigger: { type: "doc.created" },
          binding: { connector: "slack", tools: ["post-message"] },
          expiresIn: 300,
        },
        signer,
      ),
    );
    expect(check(claims)).toStrictEqual([]);
    const { scope: _scope, ...undelegated } = claims;
    expect(check(undelegated)).not.toStrictEqual([]);
    expect(check({ ...claims, kind: "cron" })).not.toStrictEqual([]);
  });

  it("accept what signSupportSession signs and reject a nested act", async () => {
    const check = validator("support-session-v1.json");
    const now = Date.now();
    const claims = claimsOf(
      await signSupportSession(
        {
          v: 1,
          id: "ss_1",
          principal: "u_customer",
          actor: "u_staff",
          tenant: "o_1",
          reason: "Ticket 4411",
          permissions: ["invoice.read"],
          startedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 3_600_000).toISOString(),
          approvedBy: "u_lead",
          reference: "4411",
        },
        signer,
      ),
    );
    expect(check(claims)).toStrictEqual([]);
    expect(
      check({ ...claims, act: { sub: "u_staff", kind: "support", act: {} } }),
    ).not.toStrictEqual([]);
    expect(check({ ...claims, permissions: [] })).not.toStrictEqual([]);
  });
});

describe("signSnapshot and signPolicyDocument", () => {
  const snapshot = json(
    new URL("../../fixtures/snapshot.json", import.meta.url),
  );

  it("signSnapshot round-trips through snapshotFromClaims with the given audience", async () => {
    const parsed = snapshotFromClaims(snapshot);
    expect(parsed).toBeNull();
    const source = snapshotFromClaims(claimsOf(jwtFixtureTokens.snapshot));
    if (source === null) {
      throw new Error("fixture snapshot did not parse");
    }
    const token = await signSnapshot(source, signer, {
      audience: "https://cloud.example.com",
    });
    const claims = claimsOf(token);
    expect(claims["aud"]).toBe("https://cloud.example.com");
    expect(snapshotFromClaims(claims)).toStrictEqual(source);
    expect(snapshotFromClaims({ snapshot: { v: 2 } })).toBeNull();
  });

  it("signPolicyDocument writes policy-v1 claims that policyDocumentFromClaims reads back", async () => {
    const check = validator("policy-v1.json");
    const document: PolicyDocument = {
      v: 1,
      id: "pol_1",
      fingerprint: "sha256:abc",
      catalog: "sha256:def",
      issuedAt: "2026-10-06T09:00:00.000Z",
      grants: [
        {
          id: "g_1",
          permission: "invoice.read",
          to: { kind: "role", role: "viewer", scope: "global" },
        },
      ],
    };
    const token = await signPolicyDocument(document, signer, {
      audience: "https://app.example.com/env/prod",
      expiresAt: 1_791_277_200,
    });
    const claims = claimsOf(token);
    expect(check(claims)).toStrictEqual([]);
    expect(claims).toMatchObject({
      aud: "https://app.example.com/env/prod",
      exp: 1_791_277_200,
      jti: "pol_1",
    });
    expect(policyDocumentFromClaims(claims)).toStrictEqual(document);
  });
});

describe("parseApprovalRequest", () => {
  const request = {
    v: 1,
    id: "apr_1",
    token: "sha-256:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    permission: "invoice.void",
    scope: "invoice:void",
    resource: { type: "invoice", id: "inv_1" },
    subject: { principal: { id: "u1", roles: ["member"] } },
    detail: "invoice.void requires human approval.",
    createdAt: "2026-10-06T09:00:00Z",
    expiresAt: "2026-10-06T10:00:00Z",
    status: "pending",
  };

  it("returns a frozen copy of a valid request", () => {
    const parsed = parseApprovalRequest(request);
    expect(parsed).toStrictEqual(request);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("returns null for an invalid, unsafe or non-JSON request", () => {
    expect(parseApprovalRequest({ ...request, status: "maybe" })).toBeNull();
    expect(
      parseApprovalRequest(JSON.parse(`{"v":1,"__proto__":{"x":1},"id":"a"}`)),
    ).toBeNull();
    expect(parseApprovalRequest({ ...request, at: () => 1 })).toBeNull();
    expect(parseApprovalRequest("apr_1")).toBeNull();
  });
});

describe("connector-v1.json", () => {
  const check = validator("connector-v1.json");
  const valid = [
    {
      kind: "webhook",
      name: "Ops",
      config: {
        url: "https://ops.example.com/hook",
        types: ["com.permdock.decision"],
      },
    },
    {
      kind: "otlp",
      name: "Grafana",
      config: { endpoint: "https://otlp.example.com", signals: ["logs"] },
    },
    {
      kind: "siem",
      name: "Splunk",
      config: {
        destination: "splunk-hec",
        endpoint: "https://hec.example.com",
        headers: { Authorization: "Splunk 00000000" },
      },
    },
    {
      kind: "evidence",
      name: "Auditor",
      config: {
        format: "jws",
        destination: "https://drop.example.com",
        schedule: "daily",
      },
    },
    {
      kind: "scim",
      name: "Okta",
      config: {
        tenant: "o_acme",
        target: "https://app.example.com/scim/v2",
        groupRoles: { g_admins: "admin" },
      },
    },
    {
      kind: "caep-transmitter",
      name: "Okta signals",
      config: { issuer: "https://acme.okta.com", delivery: "push" },
    },
    {
      kind: "federated-upstream",
      name: "Clerk",
      config: {
        discovery: "https://clerk.example.com",
        client_id: "c_1",
        scopes: ["openid"],
      },
    },
    {
      kind: "chat",
      name: "Slack",
      config: { platform: "slack", workspace: "T123" },
    },
    { kind: "email", name: "Mail", config: { from: "approvals@example.com" } },
    {
      kind: "vercel-oidc",
      name: "Vercel",
      config: { team_id: "team_1", environment: "production" },
    },
  ];

  const invalid: readonly unknown[] = [
    { kind: "trusted-issuer", name: "x", config: {} },
    { kind: "webhook", name: "x", config: {} },
    {
      kind: "chat",
      name: "x",
      config: { platform: "slack", workspace: "T", token: "xoxb" },
    },
    { kind: "webhook", name: "x", config: { url: "http://ops.example.com" } },
    {
      kind: "siem",
      name: "x",
      config: {
        destination: "datadog",
        endpoint: "https://http-intake.example.com",
        headers: { "DD-API-KEY": 1 },
      },
    },
    { kind: "otlp", name: "", config: { endpoint: "https://o.example.com" } },
    {
      kind: "otlp",
      name: "x",
      config: { endpoint: "https://o.example.com", signals: [] },
    },
    { kind: "email", name: "x", config: { from: "no-at-sign" } },
    { kind: "email", name: "x" },
    "webhook",
    null,
  ];

  it("accepts one connector of every kind", () => {
    expect(valid.map((item) => check(item))).toStrictEqual(valid.map(() => []));
    expect(new Set(valid.map((item) => item.kind)).size).toBe(10);
  });

  it("rejects an unknown kind, a missing field, an extra field and http", () => {
    for (const item of invalid) {
      expect(check(item)).not.toStrictEqual([]);
    }
  });

  it("parseConnector agrees with the schema on every fixture", () => {
    for (const item of valid) {
      const result = parseConnector(item);
      expect(result).toStrictEqual({ ok: true, connector: item });
      expect(result.ok && Object.isFrozen(result.connector.config)).toBe(true);
    }
    for (const item of invalid) {
      expect(parseConnector(item).ok).toBe(false);
    }
  });

  it("parseConnector names each issue with a JSON pointer", () => {
    expect(
      parseConnector({ kind: "trusted-issuer", name: "x", config: {} }),
    ).toMatchObject({ ok: false, issues: [{ path: "/kind" }] });
    expect(
      parseConnector({
        kind: "siem",
        name: "x",
        config: {
          destination: "datadog",
          endpoint: "https://intake.example.com",
          headers: { "a/b~c": 1 },
        },
      }),
    ).toStrictEqual({
      ok: false,
      issues: [{ path: "/config/headers/a~1b~0c", message: "Expected string" }],
    });
    expect(
      parseConnector({ kind: "webhook", name: "x", config: {} }),
    ).toStrictEqual({
      ok: false,
      issues: [{ path: "/config/url", message: "Required" }],
    });
    expect(
      parseConnector(
        JSON.parse(
          '{"kind":"email","name":"x","config":{"from":"a@b"},"__proto__":{}}',
        ),
      ),
    ).toStrictEqual({
      ok: false,
      issues: [{ path: "/__proto__", message: "Forbidden key" }],
    });
    expect(
      parseConnector({ kind: "email", name: "x", at: () => 1 }),
    ).toStrictEqual({
      ok: false,
      issues: [{ path: "/at", message: "Expected JSON, got function" }],
    });
  });
});

describe("cloud-api-v1.json", () => {
  it("is CLOUD_API_DOCUMENT and connector-v1.json is CONNECTOR_SCHEMA", () => {
    expect(json(new URL("cloud-api-v1.json", SCHEMAS))).toStrictEqual(
      CLOUD_API_DOCUMENT,
    );
    expect(json(new URL("connector-v1.json", SCHEMAS))).toStrictEqual(
      CONNECTOR_SCHEMA,
    );
  });

  it("is a valid OpenAPI 3.1 document", () => {
    expect(validateOpenapi(CLOUD_API_DOCUMENT)).toStrictEqual({
      ok: true,
      version: "3.1",
    });
  });

  it("compiles every response schema against the package schemas", () => {
    const local = new Ajv2020({ strict: false });
    for (const name of files) {
      local.addSchema(json(new URL(name, SCHEMAS)));
    }
    local.addSchema({ ...CLOUD_API_DOCUMENT, $id: "cloud-api" });
    // SAFETY: the document's paths are path items of operations, read for their response keys only.
    const paths = CLOUD_API_DOCUMENT["paths"] as Record<
      string,
      Record<
        string,
        { responses?: Record<string, { content?: Record<string, unknown> }> }
      >
    >;
    const compiled: string[] = [];
    for (const [path, item] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(item)) {
        for (const [status, response] of Object.entries(
          operation.responses ?? {},
        )) {
          for (const type of Object.keys(response.content ?? {})) {
            const pointer = [
              "paths",
              path,
              method,
              "responses",
              status,
              "content",
              type,
              "schema",
            ]
              .map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1"))
              .join("/");
            expect(local.getSchema(`cloud-api#/${pointer}`)).toBeTypeOf(
              "function",
            );
            compiled.push(`${method} ${path} ${status}`);
          }
        }
      }
    }
    expect(compiled.length).toBeGreaterThan(60);
  });
});
