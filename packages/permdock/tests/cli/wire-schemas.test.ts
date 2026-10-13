import { Ajv2020 } from "ajv/dist/2020.js";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/types.ts";
import type { SinkEvent } from "../../src/core/sink.ts";

import { signApproval } from "../../src/approvals/signature.ts";
import { signDecisionBatch } from "../../src/core/sink.ts";
import { snapshotFromClaims } from "../../src/core/snapshot-sign.ts";
import { joseTokenSigner } from "../../src/jwt/signer.ts";
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

const files = readdirSync(SCHEMAS).filter((name) => name.endsWith(".json"));

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
    throw new Error(`no fixture ${typ}`);
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
    expect(missing).toEqual([]);
  });
});

describe("snapshot-v1.json", () => {
  const check = validator("snapshot-v1.json");

  it("accepts the snapshot fixture and a snapshot read back from its token", () => {
    expect(
      check(json(new URL("../../fixtures/snapshot.json", import.meta.url))),
    ).toEqual([]);
    const claims = signedOutput("vnd.permdock.snapshot+jwt");
    expect(check(snapshotFromClaims({ iss: ISSUER, ...claims }))).toEqual([]);
    expect(
      check(snapshotFromClaims(claimsOf(jwtFixtureTokens.snapshot))),
    ).toEqual([]);
  });

  it("rejects numeric times and a scopes list", () => {
    const fixture = json(
      new URL("../../fixtures/snapshot.json", import.meta.url),
    );
    expect(check({ ...fixture, issuedAt: 1_700_000_000 })).not.toEqual([]);
    expect(
      check({
        ...fixture,
        subject: { principal: null, context: {}, delegation: { scope: ["a"] } },
      }),
    ).not.toEqual([]);
  });
});

describe("approval-signature-v1.json", () => {
  const check = validator("approval-signature-v1.json");
  const request: ApprovalRequest = {
    v: 1,
    id: "apr_1",
    token: "sha-256:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    permission: "invoice.void",
    resource: { type: "invoice", id: "inv_1" },
    subject: {
      principal: { id: "u1", roles: ["member"] },
      actor: { id: "agent_1", kind: "agent" },
    },
    createdAt: "2026-10-06T09:00:00Z",
    expiresAt: "2026-10-06T10:00:00Z",
    status: "approved",
    resolvedAt: "2026-10-06T09:05:00Z",
    resolvedBy: "u2",
    approvals: [{ by: "u2", at: "2026-10-06T09:05:00Z", stage: 0 }],
  };

  it("accepts what signApproval signs and the checked-in fixtures", async () => {
    const token = await signApproval(request, signer, undefined);
    expect(check(claimsOf(token ?? ""))).toEqual([]);
    expect(check(signedOutput("vnd.permdock.approval+jwt"))).toEqual([]);
    expect(check(claimsOf(jwtFixtureTokens.approval))).toEqual([]);
  });

  it("rejects two authorization_details and a numeric approval time", async () => {
    const claims = claimsOf(
      (await signApproval(request, signer, undefined)) ?? "",
    );
    const detail = { type: "invoice", actions: ["void"] };
    expect(
      check({ ...claims, authorization_details: [detail, detail] }),
    ).not.toEqual([]);
    expect(check({ ...claims, approvals: [{ by: "u2", at: 1 }] })).not.toEqual(
      [],
    );
  });
});

describe("capability-v1.json", () => {
  const check = validator("capability-v1.json");
  const claims = signedOutput("vnd.permdock.capability+jwt");

  it("accepts the capability fixture, with or without cnf", () => {
    expect(check(claims)).toEqual([]);
    expect(
      check({
        ...claims,
        cnf: { jkt: "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I" },
      }),
    ).toEqual([]);
  });

  it("rejects a capability without sub, with an id, or with a short jkt", () => {
    const { sub: _sub, ...unnamed } = claims;
    expect(check(unnamed)).not.toEqual([]);
    expect(check({ ...claims, capability: { v: 2 } })).not.toEqual([]);
    expect(check({ ...claims, cnf: { jkt: "short" } })).not.toEqual([]);
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
    createdAt: 1_700_000_000,
    expiresAt: 1_700_086_400,
  };

  it("accepts user, service and feed credentials", () => {
    expect(check(user)).toEqual([]);
    expect(
      check({
        ...user,
        kind: "service",
        principal: "svc_1",
        tenant: "org_1",
        roles: ["bot"],
      }),
    ).toEqual([]);
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
    ).toEqual([]);
  });

  it("rejects a service credential without a tenant and an unknown kind", () => {
    expect(check({ ...user, kind: "service", roles: ["bot"] })).not.toEqual([]);
    expect(check({ ...user, kind: "robot" })).not.toEqual([]);
  });
});

describe("policy-v1.json", () => {
  const check = validator("policy-v1.json");
  const claims = signedOutput("vnd.permdock.policy+jwt");

  it("accepts the policy fixture", () => {
    expect(check(claims)).toEqual([]);
  });

  it("rejects a document without jti or with grants that lack an id", () => {
    const { jti: _jti, ...anonymous } = claims;
    expect(check(anonymous)).not.toEqual([]);
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
    ).not.toEqual([]);
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
    expect(check(claimsOf(token))).toEqual([]);
    expect(check(signedOutput("vnd.permdock.evidence+jwt"))).toEqual([]);
  });

  it("rejects an event without specversion", () => {
    const claims = signedOutput("vnd.permdock.evidence+jwt");
    expect(
      check({
        ...claims,
        events: [{ id: "1", source: ISSUER, type: "t", data: {} }],
      }),
    ).not.toEqual([]);
  });
});
