import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { SetSubject, SsfAuditEvent } from "../../src/ssf/types.ts";

import { allow } from "../../src/core/grant-builders.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { joseTokenSigner } from "../../src/jwt/signer.ts";
import {
  SSF_POLL_DELIVERY,
  SSF_PUSH_DELIVERY,
  caepEvents,
  createPermDock,
  memorySetQueue,
  pushSet,
  riscEvents,
  setPollHandler,
  signSet,
  streamVerificationEvent,
} from "../../src/ssf/index.ts";

const ISSUER = "https://cloud.example.com/v1/environments/prod";
const AUDIENCE = "https://app.example.com/ssf";
const CAEP = "https://schemas.openid.net/secevent/caep/event-type/";
const RISC = "https://schemas.openid.net/secevent/risc/event-type/";
const PUBLIC = {
  crv: "Ed25519",
  x: "79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ",
  kty: "OKP",
  kid: "2026-09",
  alg: "Ed25519",
};
const signer = joseTokenSigner({
  key: {
    crv: "Ed25519",
    d: "qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4",
    x: PUBLIC.x,
    kty: "OKP",
  },
  alg: "Ed25519",
  kid: "2026-09",
  issuer: ISSUER,
});

const permissions = definePermissions({
  post: resource(z.object({ id: z.string() }), { id: "id", actions: ["read"] }),
});
const policy = definePolicy(permissions, {
  roles: [role("member", [allow(permissions.post.read)])],
  subject: () => ({ id: "u1", roles: ["member"] }),
});

const subject: SetSubject = { format: "iss_sub", iss: ISSUER, sub: "u1" };

function claimsOf(token: string): Record<string, unknown> {
  const [, payload = ""] = token.split(".");
  // SAFETY: the payload of a compact JWS this test signed is a JSON object.
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

function headerOf(token: string): Record<string, unknown> {
  const [header = ""] = token.split(".");
  // SAFETY: the header of a compact JWS this test signed is a JSON object.
  return JSON.parse(
    Buffer.from(header, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

function receiver() {
  const handled: string[] = [];
  const { receiver: ssf } = createPermDock(policy, {
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: { keys: [PUBLIC] },
    subject: (setSubject) =>
      typeof setSubject["sub"] === "string" ? setSubject["sub"] : null,
    onEvent: {
      "*": (input) => {
        handled.push(input.type);
      },
    },
  });
  const audit: SsfAuditEvent[] = [];
  ssf.on("event", (event) => {
    audit.push(event);
  });
  return { ssf, handled, audit };
}

function fetchTo(
  handler: (request: Request) => Promise<Response>,
): typeof fetch {
  return (input, init) => handler(new Request(input, init));
}

describe("signSet", () => {
  it("writes an RFC 8417 SET with sub_id, one event and txn", async () => {
    const token = await signSet(
      caepEvents.sessionRevoked({
        subject,
        eventTimestamp: 1_800_000_000,
        initiatingEntity: "admin",
        reasonAdmin: "Offboarded",
        reasonUser: { en: "Signed out", nl: "Afgemeld" },
      }),
      signer,
      {
        audience: AUDIENCE,
        jti: "set_1",
        txn: "tx_1",
        issuedAt: 1_800_000_000,
      },
    );
    expect(headerOf(token)["typ"]).toBe("secevent+jwt");
    expect(claimsOf(token)).toMatchObject({
      iss: ISSUER,
      aud: AUDIENCE,
      jti: "set_1",
      iat: 1_800_000_000,
      txn: "tx_1",
      sub_id: subject,
      events: {
        [`${CAEP}session-revoked`]: {
          event_timestamp: 1_800_000_000,
          initiating_entity: "admin",
          reason_admin: { en: "Offboarded" },
          reason_user: { en: "Signed out", nl: "Afgemeld" },
        },
      },
    });
  });
});

describe("event builders", () => {
  it("build every CAEP and RISC payload in snake case", () => {
    const at = { subject, eventTimestamp: 1 };
    expect(
      caepEvents.credentialChange({
        ...at,
        credentialType: "fido2-roaming",
        changeType: "revoke",
        friendlyName: "Key",
        x509Issuer: "CN=CA",
        x509Serial: "01",
        fido2Aaguid: "aaguid",
      }).payload,
    ).toEqual({
      event_timestamp: 1,
      credential_type: "fido2-roaming",
      change_type: "revoke",
      friendly_name: "Key",
      x509_issuer: "CN=CA",
      x509_serial: "01",
      fido2_aaguid: "aaguid",
    });
    expect(
      caepEvents.tokenClaimsChange({ ...at, claims: { role: "admin" } }),
    ).toEqual({
      type: `${CAEP}token-claims-change`,
      subject,
      payload: { event_timestamp: 1, claims: { role: "admin" } },
    });
    expect(
      caepEvents.assuranceLevelChange({
        ...at,
        namespace: "NIST-AAL",
        currentLevel: "nist-aal2",
        previousLevel: "nist-aal1",
        changeDirection: "increase",
      }).payload,
    ).toEqual({
      event_timestamp: 1,
      namespace: "NIST-AAL",
      current_level: "nist-aal2",
      previous_level: "nist-aal1",
      change_direction: "increase",
    });
    expect(
      caepEvents.deviceComplianceChange({
        ...at,
        previousStatus: "compliant",
        currentStatus: "not-compliant",
      }).payload,
    ).toEqual({
      event_timestamp: 1,
      previous_status: "compliant",
      current_status: "not-compliant",
    });
    expect(
      riscEvents.accountDisabled({ subject, reason: "hijacking" }),
    ).toEqual({
      type: `${RISC}account-disabled`,
      subject,
      payload: { reason: "hijacking" },
    });
    expect(riscEvents.accountPurged({ subject }).payload).toEqual({});
    expect(
      riscEvents.credentialCompromise({
        subject,
        credentialType: "password",
        reasonAdmin: "Leaked",
      }).payload,
    ).toMatchObject({
      credential_type: "password",
      reason_admin: { en: "Leaked" },
      event_timestamp: expect.any(Number),
    });
    expect(streamVerificationEvent("s_1", "abc")).toEqual({
      type: "https://schemas.openid.net/secevent/ssf/event-type/verification",
      subject: { format: "opaque", id: "s_1" },
      payload: { state: "abc" },
    });
    expect(SSF_PUSH_DELIVERY).toBe("urn:ietf:rfc:8935");
    expect(SSF_POLL_DELIVERY).toBe("urn:ietf:rfc:8936");
  });
});

describe("pushSet", () => {
  it("delivers to the PermDock receiver, which verifies and dispatches the SET", async () => {
    const { ssf, handled } = receiver();
    const token = await signSet(
      riscEvents.accountDisabled({ subject }),
      signer,
      { audience: AUDIENCE },
    );
    const result = await pushSet(token, {
      endpoint: `${AUDIENCE}/push`,
      authorization: "Bearer stream-token",
      fetch: fetchTo((request) => ssf.push(request)),
    });
    expect(result).toEqual({ ok: true });
    expect(handled).toEqual(["account-disabled"]);
  });

  it("maps the receiver's err to a cause", async () => {
    const { ssf } = receiver();
    const token = await signSet(
      caepEvents.sessionRevoked({ subject }),
      signer,
      { audience: "https://other.example.com" },
    );
    expect(
      await pushSet(token, {
        endpoint: AUDIENCE,
        fetch: fetchTo((request) => ssf.push(request)),
      }),
    ).toMatchObject({ ok: false, cause: "invalid-audience", retry: false });
  });

  it.each([
    [401, "{}", "authentication-failed", false],
    [403, "{}", "access-denied", false],
    [
      400,
      '{"err":"invalid_key","description":"bad key"}',
      "invalid-key",
      false,
    ],
    [400, '{"err":"made_up"}', "invalid-request", false],
    [400, "not json", "invalid-request", false],
    [400, "[1]", "invalid-request", false],
    [429, "{}", "unavailable", true],
    [503, '{"description":"down"}', "unavailable", true],
  ] as const)("answers %i %s with %s", async (status, body, cause, retry) => {
    const result = await pushSet("set", {
      endpoint: AUDIENCE,
      fetch: () => Promise.resolve(new Response(body, { status })),
    });
    expect(result).toMatchObject({ ok: false, cause, retry });
  });

  it("is unavailable when the request fails", async () => {
    expect(
      await pushSet("set", {
        endpoint: AUDIENCE,
        fetch: () => Promise.reject(new TypeError("offline")),
      }),
    ).toEqual({ ok: false, cause: "unavailable", retry: true });
  });

  it("is invalid-request when the error body cannot be read", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error("broken"));
      },
    });
    expect(
      await pushSet("set", {
        endpoint: AUDIENCE,
        fetch: () => Promise.resolve(new Response(body, { status: 400 })),
      }),
    ).toEqual({ ok: false, cause: "invalid-request", retry: false });
  });
});

describe("setPollHandler", () => {
  function poll(body: unknown, init: RequestInit = {}): Request {
    return new Request("https://cloud.example.com/ssf/poll", {
      method: "POST",
      headers: {
        authorization: "Bearer s_1",
        "content-type": "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    });
  }

  it("serves the PermDock receiver's poll, which acknowledges what it accepted", async () => {
    const queue = memorySetQueue();
    const handler = setPollHandler({
      queue,
      authorize: (request) =>
        request.headers.get("authorization") === "Bearer s_1" ? "s_1" : null,
    });
    const token = await signSet(
      caepEvents.sessionRevoked({ subject }),
      signer,
      { audience: AUDIENCE, jti: "set_1" },
    );
    await queue.enqueue("s_1", "set_1", token);
    await queue.enqueue("s_1", "set_2", "not-a-jwt");
    const { ssf, handled } = receiver();
    const result = await ssf.poll({
      endpoint: "https://cloud.example.com/ssf/poll",
      token: "s_1",
      fetch: fetchTo(handler),
    });
    expect(result).toEqual({ acked: ["set_1"] });
    expect(handled).toEqual(["session-revoked"]);
    expect(await queue.pending("s_1", 10)).toEqual([]);
  });

  it("caps maxEvents and reports moreAvailable", async () => {
    const queue = memorySetQueue();
    for (const jti of ["a", "b", "c"]) {
      await queue.enqueue("s_1", jti, `set-${jti}`);
    }
    const handler = setPollHandler({
      queue,
      authorize: () => "s_1",
      maxEvents: 2,
    });
    const first = await handler(poll({ maxEvents: 5 }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      sets: { a: "set-a", b: "set-b" },
      moreAvailable: true,
    });
    const acked = await handler(
      poll({
        acks: ["a"],
        setErrs: { b: { err: "invalid_key", description: "bad" } },
        maxEvents: 0,
      }),
    );
    expect(await acked.json()).toEqual({ sets: {} });
    expect(await (await handler(poll(""))).json()).toEqual({
      sets: { c: "set-c" },
    });
    expect(await queue.pending("s_1", -1)).toEqual([]);
  });

  it("refuses an unauthorised caller, a wrong method and a malformed body", async () => {
    const handler = setPollHandler({
      queue: memorySetQueue(),
      authorize: (request) =>
        request.headers.get("authorization") === null ? null : "s_1",
    });
    const unauthorised = await handler(
      poll({}, { headers: { "content-type": "application/json" } }),
    );
    expect(unauthorised.status).toBe(401);
    expect(await unauthorised.json()).toMatchObject({
      err: "authentication_failed",
    });
    const throwing = setPollHandler({
      queue: memorySetQueue(),
      authorize: () => {
        throw new Error("down");
      },
    });
    expect((await throwing(poll({}))).status).toBe(401);
    expect(
      (
        await handler(
          new Request("https://cloud.example.com/ssf/poll", { method: "GET" }),
        )
      ).status,
    ).toBe(405);
    for (const body of [
      "{",
      "[]",
      { maxEvents: -1 },
      { maxEvents: 1.5 },
      { acks: "a" },
      { acks: [1] },
      { setErrs: [] },
      { setErrs: { a: { err: 1, description: "x" } } },
    ]) {
      const response = await handler(poll(body));
      expect(response.status).toBe(400);
    }
  });
});
