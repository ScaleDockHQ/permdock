import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { SsfStreamConfiguration } from "../../src/ssf/types.ts";

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
  fanOutSet,
  memorySetQueue,
  memorySsfStreamStore,
  pollSets,
  ssfTransmitter,
} from "../../src/ssf/index.ts";
import { testSsfStreamStore } from "../../src/testing/index.ts";

const ISSUER = "https://cloud.example.com/ssf";
const AUDIENCE = "https://app.example.com/ssf";
const CAEP = "https://schemas.openid.net/secevent/caep/event-type/";
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

const subject = { format: "iss_sub", iss: ISSUER, sub: "u1" };

function transmitter(overrides: { readonly fetch?: typeof fetch } = {}) {
  const streams = memorySsfStreamStore();
  const queue = memorySetQueue();
  const handler = ssfTransmitter({
    issuer: ISSUER,
    streams,
    queue,
    signer,
    jwksUri: `${ISSUER}/jwks.json`,
    audience: () => AUDIENCE,
    authorize: (request) => {
      const value = request.headers.get("authorization") ?? "";
      return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : null;
    },
    ...overrides,
  });
  const call = (
    method: string,
    path: string,
    body?: unknown,
    caller = "r_1",
  ): Promise<Response> =>
    handler(
      new Request(`${ISSUER}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${caller}`,
          "content-type": "application/json",
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    );
  const create = async (
    body: unknown,
    caller = "r_1",
  ): Promise<SsfStreamConfiguration> => {
    const response = await call("POST", "/stream", body, caller);
    expect(response.status).toBe(201);
    // SAFETY: a 201 from the stream endpoint carries the stream configuration.
    return (await response.json()) as SsfStreamConfiguration;
  };
  return { handler, streams, queue, call, create };
}

function fetchTo(
  handler: (request: Request) => Promise<Response>,
): typeof fetch {
  return (input, init) => handler(new Request(input, init));
}

function receiver() {
  const handled: string[] = [];
  const states: (string | undefined)[] = [];
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
      verification: (input) => {
        states.push(input.state);
      },
    },
  });
  return { ssf, handled, states };
}

describe("ssfTransmitter", () => {
  it("serves the section 7.1 metadata without credentials", async () => {
    const { handler } = transmitter();
    const response = await handler(
      new Request("https://cloud.example.com/.well-known/ssf-configuration"),
    );
    expect(await response.json()).toEqual({
      spec_version: "1_0",
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/jwks.json`,
      delivery_methods_supported: [SSF_PUSH_DELIVERY, SSF_POLL_DELIVERY],
      configuration_endpoint: `${ISSUER}/stream`,
      status_endpoint: `${ISSUER}/status`,
      verification_endpoint: `${ISSUER}/verify`,
      authorization_schemes: [{ spec_urn: "urn:ietf:rfc:6750" }],
      default_subjects: "ALL",
    });
  });

  it("refuses stream management without credentials or when authorize throws", async () => {
    const { handler } = transmitter();
    const anonymous = await handler(new Request(`${ISSUER}/stream`));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
    const throwing = ssfTransmitter({
      issuer: ISSUER,
      streams: memorySsfStreamStore(),
      queue: memorySetQueue(),
      signer,
      authorize: () => {
        throw new Error("down");
      },
    });
    expect((await throwing(new Request(`${ISSUER}/stream`))).status).toBe(401);
  });

  it("creates, reads, updates and deletes a receiver's own streams", async () => {
    const { call, create } = transmitter();
    const created = await create({
      events_requested: [`${CAEP}session-revoked`, "urn:example:unknown"],
      description: "app",
    });
    expect(created).toMatchObject({
      iss: ISSUER,
      aud: AUDIENCE,
      events_requested: [`${CAEP}session-revoked`, "urn:example:unknown"],
      events_delivered: [`${CAEP}session-revoked`],
      delivery: {
        method: SSF_POLL_DELIVERY,
        endpoint_url: `${ISSUER}/poll?stream_id=${created.stream_id}`,
      },
      description: "app",
    });
    const id = created.stream_id;
    expect(await (await call("GET", `/stream?stream_id=${id}`)).json()).toEqual(
      created,
    );
    expect(await (await call("GET", "/stream")).json()).toEqual([created]);
    expect(
      (await call("GET", `/stream?stream_id=${id}`, undefined, "r_2")).status,
    ).toBe(404);
    expect(
      await (await call("GET", "/stream", undefined, "r_2")).json(),
    ).toEqual([]);

    const patched = await call("PATCH", "/stream", {
      stream_id: id,
      description: "renamed",
    });
    expect(await patched.json()).toMatchObject({
      events_delivered: [`${CAEP}session-revoked`],
      description: "renamed",
    });
    const replaced = await call("PUT", "/stream", {
      stream_id: id,
      delivery: { method: SSF_PUSH_DELIVERY, endpoint_url: AUDIENCE },
    });
    const body: unknown = await replaced.json();
    expect(body).toMatchObject({
      events_requested: [],
      events_delivered: [],
      delivery: { method: SSF_PUSH_DELIVERY, endpoint_url: AUDIENCE },
    });
    expect(body).not.toHaveProperty("description");

    expect(
      (await call("DELETE", `/stream?stream_id=${id}`, undefined, "r_2"))
        .status,
    ).toBe(404);
    expect((await call("DELETE", `/stream?stream_id=${id}`)).status).toBe(204);
    expect((await call("GET", `/stream?stream_id=${id}`)).status).toBe(404);
  });

  it.each<[string, unknown, string]>([
    ["a non-JSON body", "{", "body was not valid JSON"],
    ["a non-object body", [], "body must be a JSON object"],
    [
      "an unknown delivery method",
      { delivery: { method: "urn:example" } },
      `delivery.method must be ${SSF_PUSH_DELIVERY} or ${SSF_POLL_DELIVERY}`,
    ],
    [
      "a push stream without an endpoint",
      { delivery: { method: SSF_PUSH_DELIVERY } },
      "delivery.endpoint_url must be an http or https URL for push",
    ],
    [
      "a non-string authorization header",
      {
        delivery: {
          method: SSF_PUSH_DELIVERY,
          endpoint_url: AUDIENCE,
          authorization_header: 1,
        },
      },
      "delivery.authorization_header must be a string",
    ],
    [
      "events_requested that is not a string array",
      { events_requested: [1] },
      "events_requested must be an array of strings",
    ],
    [
      "a non-string description",
      { description: 1 },
      "description must be a string",
    ],
  ])("answers 400 to %s", async (_label, body, detail) => {
    const { call } = transmitter();
    const response = await call("POST", "/stream", body);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({ detail });
  });

  it("answers 400 without a stream_id and 405 to other methods", async () => {
    const { call } = transmitter();
    expect((await call("PATCH", "/stream", {})).status).toBe(400);
    expect((await call("DELETE", "/stream")).status).toBe(400);
    expect((await call("HEAD", "/stream")).status).toBe(405);
    expect((await call("PUT", "/status", {})).status).toBe(405);
    expect((await call("GET", "/verify")).status).toBe(405);
    expect((await call("GET", "/elsewhere")).status).toBe(404);
  });

  it("fans a SET out to a poll stream the PermDock receiver polls", async () => {
    const { handler, streams, queue, create } = transmitter();
    const stream = await create({
      events_requested: [`${CAEP}session-revoked`],
    });
    await create({ events_requested: [`${CAEP}credential-change`] }, "r_2");
    const rows = await fanOutSet(caepEvents.sessionRevoked({ subject }), {
      streams,
      queue,
      signer,
    });
    expect(rows).toEqual([
      {
        stream: stream.stream_id,
        jti: expect.any(String),
        queued: true,
        delivery: { ok: true },
      },
    ]);
    const { ssf, handled } = receiver();
    const result = await ssf.poll({
      endpoint: stream.delivery.endpoint_url ?? "",
      token: "r_1",
      fetch: fetchTo(handler),
    });
    expect(result).toEqual({ acked: [rows[0]?.jti] });
    expect(handled).toEqual(["session-revoked"]);
    expect(await queue.pending(stream.stream_id, 10)).toEqual([]);
  });

  it("refuses a poll for another receiver's stream or a push stream", async () => {
    const { call, create } = transmitter();
    const poll = await create({});
    const push = await create({
      delivery: { method: SSF_PUSH_DELIVERY, endpoint_url: AUDIENCE },
    });
    expect(
      (await call("POST", `/poll?stream_id=${poll.stream_id}`, {}, "r_2"))
        .status,
    ).toBe(404);
    expect(
      (await call("POST", `/poll?stream_id=${push.stream_id}`, {})).status,
    ).toBe(404);
    expect((await call("POST", "/poll", {})).status).toBe(404);
  });

  it("pushes a SET once per audience to every push stream with its authorization header", async () => {
    const pushed: { url: string; authorization: string | null }[] = [];
    const fetchFn = vi.fn<typeof fetch>((input, init) => {
      pushed.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Promise.resolve(new Response(null, { status: 202 }));
    });
    const { streams, queue, create } = transmitter();
    for (const receiverId of ["r_1", "r_2"]) {
      await create(
        {
          events_requested: [`${CAEP}session-revoked`],
          delivery: {
            method: SSF_PUSH_DELIVERY,
            endpoint_url: `${AUDIENCE}/${receiverId}`,
            authorization_header: `Bearer push-${receiverId}`,
          },
        },
        receiverId,
      );
    }
    const rows = await fanOutSet(caepEvents.sessionRevoked({ subject }), {
      streams,
      queue,
      signer,
      fetch: fetchFn,
    });
    expect(rows.map((row) => row.delivery)).toEqual([
      { ok: true },
      { ok: true },
    ]);
    expect(new Set(rows.map((row) => row.jti)).size).toBe(1);
    expect(pushed).toEqual([
      { url: `${AUDIENCE}/r_1`, authorization: "Bearer push-r_1" },
      { url: `${AUDIENCE}/r_2`, authorization: "Bearer push-r_2" },
    ]);
  });

  it("holds SETs while paused, delivers them when enabled and drops them when disabled", async () => {
    const pushed: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      pushed.push(String(init?.body));
      return new Response(null, { status: 202 });
    });
    const { call, create, streams, queue } = transmitter({ fetch: fetchFn });
    const poll = await create({ events_requested: [`${CAEP}session-revoked`] });
    const push = await create({
      events_requested: [`${CAEP}session-revoked`],
      delivery: { method: SSF_PUSH_DELIVERY, endpoint_url: AUDIENCE },
    });
    for (const id of [poll.stream_id, push.stream_id]) {
      const paused = await call("POST", "/status", {
        stream_id: id,
        status: "paused",
        reason: "maintenance",
      });
      expect(await paused.json()).toEqual({
        stream_id: id,
        status: "paused",
        reason: "maintenance",
      });
    }
    const rows = await fanOutSet(caepEvents.sessionRevoked({ subject }), {
      streams,
      queue,
      signer,
      fetch: fetchFn,
    });
    expect(rows.every((row) => row.queued)).toBe(true);
    expect(pushed).toEqual([]);
    const held = await call("POST", `/poll?stream_id=${poll.stream_id}`, {});
    expect(await held.json()).toEqual({ sets: {} });

    await call("POST", "/status", {
      stream_id: push.stream_id,
      status: "enabled",
    });
    expect(pushed).toHaveLength(1);
    expect(await queue.pending(push.stream_id, 10)).toEqual([]);

    await call("POST", "/status", {
      stream_id: poll.stream_id,
      status: "disabled",
    });
    expect(await queue.pending(poll.stream_id, 10)).toEqual([]);
    expect(
      await (await call("GET", `/status?stream_id=${poll.stream_id}`)).json(),
    ).toEqual({ stream_id: poll.stream_id, status: "disabled" });
    const after = await fanOutSet(caepEvents.sessionRevoked({ subject }), {
      streams,
      queue,
      signer,
      fetch: fetchFn,
    });
    expect(after.map((row) => row.stream)).toEqual([push.stream_id]);
  });

  it("answers 400 to a malformed body, 413 to an oversized one and 404 to another receiver's stream", async () => {
    const { call, create } = transmitter();
    expect(
      await (await call("POST", "/stream", { delivery: "push" })).json(),
    ).toMatchObject({ status: 400, detail: "delivery must be an object" });
    const stream = await create({ delivery: { method: SSF_POLL_DELIVERY } });
    const id = stream.stream_id;
    expect(
      (await call("POST", "/stream", `"${"x".repeat(70_000)}"`)).status,
    ).toBe(413);
    expect(
      await (
        await call("PUT", "/stream", {
          stream_id: id,
          delivery: { method: "urn:example:mail" },
        })
      ).json(),
    ).toMatchObject({ status: 400 });
    for (const path of ["/stream", "/status", "/verify"]) {
      const method = path === "/stream" ? "PATCH" : "POST";
      expect((await call(method, path, "[]")).status).toBe(400);
    }
    for (const path of ["/status", "/verify"]) {
      expect(
        (await call("POST", path, { stream_id: id, status: "paused" }, "r_2"))
          .status,
      ).toBe(404);
    }
    expect(
      await (
        await call("POST", "/status", {
          stream_id: id,
          status: "paused",
          reason: 1,
        })
      ).json(),
    ).toMatchObject({ status: 400, detail: "reason must be a string" });
    expect(
      await (await call("POST", "/verify", { stream_id: id, state: 1 })).json(),
    ).toMatchObject({ status: 400, detail: "state must be a string" });
  });

  it("stops a flush on a retryable push and records a permanent failure", async () => {
    const statuses = [503, 400, 202];
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(null, { status: statuses.shift() ?? 202 }),
    );
    const { call, create, streams, queue } = transmitter({ fetch: fetchFn });
    const push = await create({
      events_requested: [`${CAEP}session-revoked`],
      delivery: { method: SSF_PUSH_DELIVERY, endpoint_url: AUDIENCE },
    });
    const status = (next: string): Promise<Response> =>
      call("POST", "/status", { stream_id: push.stream_id, status: next });
    await status("paused");
    await fanOutSet(caepEvents.sessionRevoked({ subject }), {
      streams,
      queue,
      signer,
      fetch: fetchFn,
    });
    expect((await status("enabled")).status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await queue.pending(push.stream_id, 10)).toHaveLength(1);
    await status("paused");
    expect((await status("enabled")).status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(await queue.pending(push.stream_id, 10)).toEqual([]);
  });

  it("defaults a stream's aud to the receiver the authorize hook names", async () => {
    const handler = ssfTransmitter({
      issuer: ISSUER,
      streams: memorySsfStreamStore(),
      queue: memorySetQueue(),
      signer,
      authorize: () => "https://receiver.example.com",
    });
    const response = await handler(
      new Request(`${ISSUER}/stream`, { method: "POST", body: "{}" }),
    );
    expect(await response.json()).toMatchObject({
      aud: "https://receiver.example.com",
    });
  });

  it("answers 400 to an unknown status", async () => {
    const { call, create } = transmitter();
    const stream = await create({});
    const response = await call("POST", "/status", {
      stream_id: stream.stream_id,
      status: "stopped",
    });
    expect(await response.json()).toMatchObject({
      status: 400,
      detail: "status must be one of enabled, paused, disabled",
    });
  });

  it("sends a verification event with the receiver's state", async () => {
    const { handler, call, create } = transmitter();
    const stream = await create({});
    const verified = await call("POST", "/verify", {
      stream_id: stream.stream_id,
      state: "abc",
    });
    expect(verified.status).toBe(204);
    const { ssf, states } = receiver();
    await ssf.poll({
      endpoint: stream.delivery.endpoint_url ?? "",
      token: "r_1",
      fetch: fetchTo(handler),
    });
    expect(states).toEqual(["abc"]);

    await call("POST", "/status", {
      stream_id: stream.stream_id,
      status: "disabled",
    });
    expect(
      (await call("POST", "/verify", { stream_id: stream.stream_id })).status,
    ).toBe(409);
  });
});

describe("pollSets", () => {
  it("sends acks and setErrs and answers the SETs unverified", async () => {
    const bodies: unknown[] = [];
    const result = await pollSets({
      endpoint: `${ISSUER}/poll`,
      authorization: "Bearer r_1",
      acks: ["a"],
      setErrs: { b: { err: "invalid_key", description: "unknown kid" } },
      maxEvents: 5,
      fetch: (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(
          Response.json({ sets: { j1: "set-1", j2: 2 }, moreAvailable: true }),
        );
      },
    });
    expect(bodies).toEqual([
      {
        acks: ["a"],
        setErrs: { b: { err: "invalid_key", description: "unknown kid" } },
        maxEvents: 5,
        returnImmediately: true,
      },
    ]);
    expect(result).toEqual({
      ok: true,
      sets: [{ jti: "j1", set: "set-1" }],
      moreAvailable: true,
    });
  });

  it.each<[string, () => Promise<Response>, unknown]>([
    [
      "a network failure",
      () => Promise.reject(new Error("offline")),
      { ok: false, cause: "unavailable", retry: true },
    ],
    [
      "a 503",
      () => Promise.resolve(new Response(null, { status: 503 })),
      { ok: false, cause: "unavailable", retry: true },
    ],
    [
      "a 401",
      () => Promise.resolve(new Response(null, { status: 401 })),
      { ok: false, cause: "authentication-failed", retry: false },
    ],
    [
      "a body without sets",
      () => Promise.resolve(Response.json({ sets: [] })),
      {
        ok: false,
        cause: "invalid-request",
        description: "poll response has no sets object",
        retry: false,
      },
    ],
    [
      "a body that is not JSON",
      () => Promise.resolve(new Response("<html>")),
      {
        ok: false,
        cause: "invalid-request",
        description: "poll response has no sets object",
        retry: false,
      },
    ],
  ])("maps %s to a failure", async (_label, respond, expected) => {
    expect(
      await pollSets({ endpoint: `${ISSUER}/poll`, fetch: respond }),
    ).toEqual(expected);
  });
});

describe("memorySsfStreamStore", () => {
  testSsfStreamStore(memorySsfStreamStore());
});
