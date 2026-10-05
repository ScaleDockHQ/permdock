import { Ajv } from "ajv";
import { SignJWT, exportJWK, generateKeyPair, importJWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { DecisionEvent } from "../../src/core/interfaces.ts";
import type { OcsfClass } from "./fixtures.ts";

import { accessToOcsf, toOcsf } from "../../src/core/ocsf.ts";
import { createPermDock as createServerKernel } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy } from "../../src/core/policy.ts";
import { accessEvent, toCloudEvent } from "../../src/core/sink.ts";
import { createPermDock } from "../../src/ssf/index.ts";
import { standardsFixture } from "./fixtures.ts";

const ISSUER = "https://idp.example.com";
const AUDIENCE = "https://app.example.com/ssf";
const NOW = Math.floor(Date.now() / 1000);
const CAEP = "https://schemas.openid.net/secevent/caep/event-type/";
const CAEP_EVENTS = [
  "session-revoked",
  "credential-change",
  "assurance-level-change",
  "token-claims-change",
  "device-compliance-change",
] as const;

const permissions = definePermissions({
  post: resource(z.object({ id: z.string() }), {
    id: "id",
    actions: ["read"],
  }),
});
const policy = definePolicy(permissions, {
  principal: () => null,
  grants: [allow(permissions.post.read, { to: { kind: "authenticated" } })],
});

let privateJwk: Record<string, unknown>;
let publicJwk: Record<string, unknown>;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateJwk = { ...(await exportJWK(pair.privateKey)), kid: "tx-1" };
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "tx-1" };
});

async function set(
  claims: Record<string, unknown>,
  options: {
    readonly typ?: string;
    readonly audience?: string;
    readonly issuer?: string;
  } = {},
): Promise<string> {
  return new SignJWT({
    jti: crypto.randomUUID(),
    sub_id: { format: "iss_sub", iss: ISSUER, sub: "u_1" },
    events: { [`${CAEP}session-revoked`]: { event_timestamp: NOW } },
    ...claims,
  })
    .setProtectedHeader({
      alg: "ES256",
      kid: "tx-1",
      typ: options.typ ?? "secevent+jwt",
    })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(NOW)
    .sign(await importJWK(privateJwk, "ES256"));
}

function receiver(seen: string[] = []) {
  return createPermDock(policy, {
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: { keys: [publicJwk] },
    subject: (subject) => String(subject["sub"] ?? subject["id"]),
    onEvent: {
      "*": ({ type, subject }) => {
        seen.push(`${type} ${subject.id}`);
      },
    },
  }).receiver;
}

function push(token: string, contentType = "application/secevent+jwt") {
  return new Request(AUDIENCE, {
    method: "POST",
    headers: { "content-type": contentType },
    body: token,
  });
}

describe("RFC 8417 Security Event Token", () => {
  it("section 2.2: a SET without exp is accepted when it carries iat, jti and events", async () => {
    const seen: string[] = [];
    const response = await receiver(seen).push(push(await set({})));
    expect(response.status).toBe(202);
    expect(seen).toEqual(["session-revoked u_1"]);
  });

  it("section 2.3: typ must be secevent+jwt, so an access token is never a SET", async () => {
    const seen: string[] = [];
    const response = await receiver(seen).push(
      push(await set({}, { typ: "at+jwt" })),
    );
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("section 2.2: a SET without events or jti is refused", async () => {
    const handle = receiver();
    for (const claims of [{ events: undefined }, { jti: undefined }]) {
      const response = await handle.push(push(await set(claims)));
      expect(await response.json()).toMatchObject({ err: "invalid_request" });
    }
  });

  it("RFC 9493: sub_id carries the subject identifier", async () => {
    const seen: string[] = [];
    const handle = receiver(seen);
    await handle.push(
      push(await set({ sub_id: { format: "opaque", id: "u_opaque" } })),
    );
    expect(seen).toEqual(["session-revoked u_opaque"]);
  });
});

describe("CAEP 1.0 event types", () => {
  it("each CAEP event URI dispatches under its short name", async () => {
    for (const name of CAEP_EVENTS) {
      const seen: string[] = [];
      const handled: string[] = [];
      const { receiver: handle } = createPermDock(policy, {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwks: { keys: [publicJwk] },
        subject: () => "u_1",
        onEvent: {
          [name]: ({ type }: { readonly type: string }) => {
            handled.push(type);
          },
        },
      });
      handle.on("event", (event) => {
        seen.push(event.type);
      });
      const response = await handle.push(
        push(await set({ events: { [`${CAEP}${name}`]: {} } })),
      );
      expect({ name, status: response.status, handled }).toEqual({
        name,
        status: 202,
        handled: [name],
      });
      expect(seen).toContain(name);
    }
  });

  it("an event URI outside CAEP is never acted on without a wildcard handler", async () => {
    const handled: string[] = [];
    const { receiver: handle } = createPermDock(policy, {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks: { keys: [publicJwk] },
      subject: () => "u_1",
      onEvent: {
        "session-revoked": () => {
          handled.push("revoked");
        },
      },
    });
    const response = await handle.push(
      push(
        await set({
          events: { "https://schemas.example.com/event-type/custom": {} },
        }),
      ),
    );
    expect(response.status).toBe(202);
    expect(handled).toEqual([]);
  });
});

describe("RFC 8935 push delivery", () => {
  it("section 2: success is 202 with no body", async () => {
    const response = await receiver().push(push(await set({})));
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("section 2.3: errors are 400 with a JSON err and description", async () => {
    const handle = receiver();
    const wrongKey = await generateKeyPair("ES256");
    const forged = await new SignJWT({
      jti: "x",
      events: { [`${CAEP}session-revoked`]: {} },
    })
      .setProtectedHeader({ alg: "ES256", kid: "tx-1", typ: "secevent+jwt" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(NOW)
      .sign(wrongKey.privateKey);
    const cases = [
      { token: forged, err: "invalid_key" },
      {
        token: await set({}, { audience: "https://other.example.com" }),
        err: "invalid_audience",
      },
      {
        token: await set({}, { issuer: "https://evil.example.com" }),
        err: "invalid_issuer",
      },
    ];
    for (const { token, err } of cases) {
      const response = await handle.push(push(token));
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/json");
      const body: unknown = await response.json();
      expect(body).toMatchObject({ err, description: expect.any(String) });
    }
  });

  it("section 2.1: the SET is POSTed as application/secevent+jwt", async () => {
    const handle = receiver();
    const token = await set({});
    const json = await handle.push(push(token, "application/json"));
    expect(json.status).toBe(400);
    expect(await json.json()).toMatchObject({ err: "invalid_request" });
    const get = await handle.push(new Request(AUDIENCE));
    expect(get.status).toBe(400);
  });

  it("section 2.2: a redelivered jti is acknowledged and acted on once", async () => {
    const seen: string[] = [];
    const handle = receiver(seen);
    const token = await set({});
    expect((await handle.push(push(token))).status).toBe(202);
    expect((await handle.push(push(token))).status).toBe(202);
    expect(seen).toHaveLength(1);
  });
});

describe("RFC 8936 poll delivery", () => {
  it("section 2.4: accepted SETs are acked and invalid SETs reported in setErrs", async () => {
    const good = await set({ jti: "good" });
    const bad = await set(
      { jti: "bad" },
      { audience: "https://other.example.com" },
    );
    const bodies: Record<string, unknown>[] = [];
    const result = await receiver().poll({
      endpoint: `${ISSUER}/ssf/poll`,
      fetch: async (_url, init) => {
        // SAFETY: pollOnce always sends a JSON object body.
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json(
          bodies.length === 1 ? { sets: { good, bad } } : { sets: {} },
        );
      },
    });
    expect(result).toEqual({ acked: ["good"] });
    expect(bodies[0]).toMatchObject({ returnImmediately: true });
    expect(bodies[1]).toEqual({
      acks: ["good"],
      setErrs: {
        bad: { err: "invalid_audience", description: "wrong-audience" },
      },
      maxEvents: 0,
      returnImmediately: true,
    });
  });

  it("section 2.4: a SET whose handler failed is neither acked nor reported, so it is redelivered", async () => {
    const token = await set({ jti: "retry" });
    const bodies: unknown[] = [];
    const { receiver: handle } = createPermDock(policy, {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks: { keys: [publicJwk] },
      subject: () => "u_1",
      onEvent: {
        "session-revoked": () => {
          throw new Error("cache down");
        },
      },
    });
    const result = await handle.poll({
      endpoint: `${ISSUER}/ssf/poll`,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ sets: { retry: token } });
      },
    });
    expect(result).toEqual({ acked: [] });
    expect(bodies).toHaveLength(1);
  });

  it("section 2.1: the poll carries the bearer token", async () => {
    const headers: Headers[] = [];
    await receiver().poll({
      endpoint: `${ISSUER}/ssf/poll`,
      token: "poll-secret",
      fetch: async (_url, init) => {
        headers.push(new Headers(init?.headers));
        return Response.json({ sets: {} });
      },
    });
    expect(headers[0]?.get("authorization")).toBe("Bearer poll-secret");
  });
});

describe("Audit path: CloudEvents 1.0.2 and OCSF 1.3.0", () => {
  async function decisionEvents(): Promise<DecisionEvent[]> {
    const events: DecisionEvent[] = [];
    for (const user of [{ id: "u_1" }, null]) {
      const permdock = await createServerKernel(policy, user);
      permdock.on("decision", (event) => {
        // SAFETY: the decision channel carries DecisionEvent payloads.
        events.push(event as DecisionEvent);
      });
      permdock.decide(permissions.post.read, { id: "p1" }, { adapter: "test" });
    }
    return events;
  }

  type OcsfAttribute = OcsfClass["attributes"][number][string];

  function attributesOf(fixture: OcsfClass): Record<string, OcsfAttribute> {
    const merged: Record<string, OcsfAttribute> = {};
    for (const entry of fixture.attributes) {
      Object.assign(merged, entry);
    }
    return merged;
  }

  function required(fixture: OcsfClass): readonly string[] {
    return Object.entries(attributesOf(fixture))
      .filter(
        ([, attribute]) =>
          attribute.requirement === "required" &&
          (attribute.profile ?? null) === null,
      )
      .map(([name]) => name);
  }

  function enumKeys(fixture: OcsfClass, name: string): readonly number[] {
    const attribute = fixture.attributes.find((entry) => name in entry)?.[name];
    return Object.keys(attribute?.enum ?? {}).map(Number);
  }

  it("every decision event is a valid CloudEvent", async () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(
      standardsFixture("cloudevents-1.0.2.schema.json"),
    );
    const events = await decisionEvents();
    expect(events).toHaveLength(2);
    for (const event of events) {
      const cloudEvent = toCloudEvent(event, "https://app.example.com");
      const valid = validate(cloudEvent);
      expect({ valid, errors: validate.errors ?? null }).toEqual({
        valid: true,
        errors: null,
      });
    }
  });

  it("toOcsf fills every required Authorize Session attribute with a defined enum value", async () => {
    const fixture = standardsFixture("ocsf-1.3.0-authorize_session.json");
    for (const event of await decisionEvents()) {
      const ocsf: Record<string, unknown> = toOcsf(event);
      expect(
        required(fixture).filter((name) => ocsf[name] === undefined),
      ).toEqual([]);
      expect(ocsf["class_uid"]).toBe(fixture.uid);
      expect(ocsf["category_uid"]).toBe(fixture.category_uid);
      expect(enumKeys(fixture, "activity_id")).toContain(ocsf["activity_id"]);
      expect(enumKeys(fixture, "status_id")).toContain(ocsf["status_id"]);
      expect(enumKeys(fixture, "severity_id")).toContain(ocsf["severity_id"]);
      expect(ocsf["type_uid"]).toBe(
        fixture.uid * 100 + Number(ocsf["activity_id"]),
      );
    }
  });

  it("accessToOcsf uses Account Change Enable and Disable", () => {
    const fixture = standardsFixture("ocsf-1.3.0-account_change.json");
    const activities = attributesOf(fixture)["activity_id"]?.enum ?? {};
    const caption = (id: unknown): unknown => {
      const entry = activities[String(id)];
      return entry !== null && typeof entry === "object" && "caption" in entry
        ? entry.caption
        : undefined;
    };
    for (const [operation, expected] of [
      ["started", "Enable"],
      ["ended", "Disable"],
      ["revoked", "Disable"],
    ] as const) {
      const ocsf: Record<string, unknown> = accessToOcsf(
        accessEvent({
          source: "app",
          operation,
          tenant: "T",
          principal: { id: "agent" },
          roles: ["support"],
        }),
      );
      expect(
        required(fixture).filter((name) => ocsf[name] === undefined),
      ).toEqual([]);
      expect({ operation, caption: caption(ocsf["activity_id"]) }).toEqual({
        operation,
        caption: expected,
      });
      expect(ocsf["type_uid"]).toBe(
        fixture.uid * 100 + Number(ocsf["activity_id"]),
      );
    }
  });
});
