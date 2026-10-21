import { describe, expect, it } from "vitest";

import type {
  DecisionEvent,
  DirectoryEvent,
} from "../../src/core/event-types.ts";
import type { TokenSigner } from "../../src/core/interfaces.ts";

import {
  accessEvent,
  cloudEventType,
  credentialEvent,
  membershipEvent,
  memoryDecisionSink,
  signDecisionBatch,
  toCloudEvent,
} from "../../src/core/sink.ts";
import { isDecisionEvent } from "../fixtures/decisions.ts";

const event = (id: string): DecisionEvent => ({
  type: "decision",
  at: "2026-01-01T00:00:00.000Z",
  outcome: "granted",
  permission: "post.read",
  scope: "post:read",
  resource: { type: "post", id },
  subject: { principal: { id: "u1", roles: ["member"] } },
  trusted: true,
  call: "decide",
});

describe(memoryDecisionSink, () => {
  it("buffers events and drops the oldest past capacity", () => {
    const sink = memoryDecisionSink({ capacity: 2 });
    void sink.write([event("1"), event("2"), event("3")]);
    expect(
      sink
        .events()
        .filter(isDecisionEvent)
        .map((item) => item.resource.id),
    ).toStrictEqual(["2", "3"]);
  });

  it("signs each write as a vnd.permdock.evidence+jwt batch", async () => {
    const signed: {
      readonly payload: Readonly<Record<string, unknown>>;
      readonly typ: string;
    }[] = [];
    const signer: TokenSigner = {
      async sign(payload, options) {
        signed.push({ payload, typ: options.typ });
        return "jws.batch";
      },
    };
    const sink = memoryDecisionSink({
      signer,
      audience: "https://siem.example.com",
      source: "https://app.example.com",
    });
    await sink.write([event("42")]);
    expect(sink.batches()).toStrictEqual(["jws.batch"]);
    expect(signed[0]?.typ).toBe("vnd.permdock.evidence+jwt");
    // SAFETY: the signed batch payload's events field is the list of CloudEvents objects.
    const events = signed[0]?.payload["events"] as readonly Record<
      string,
      unknown
    >[];
    expect(events[0]).toMatchObject({
      specversion: "1.0",
      type: "com.permdock.decision",
      source: "https://app.example.com",
      subject: "post.read",
      datacontenttype: "application/json",
      dataschema: "https://permdock.com/schemas/decision-event-v1.json",
      data: { permission: "post.read", resource: { id: "42" } },
    });
  });

  it("swallows signer failures so a write never throws", async () => {
    const sink = memoryDecisionSink({
      signer: {
        sign() {
          return Promise.reject(new Error("unavailable"));
        },
      },
      source: "https://app.example.com",
    });
    await expect(sink.write([event("1")])).resolves.toBeUndefined();
    expect(sink.batches()).toStrictEqual([]);
    expect(sink.events()).toHaveLength(1);
  });
});

describe(signDecisionBatch, () => {
  it("envelopes directory and approval events", async () => {
    const directory: DirectoryEvent = {
      type: "directory",
      at: "2026-01-01T00:00:00.000Z",
      source: "scim",
      operation: "patch",
      tenant: "o_acme",
      resource: { type: "User", id: "u_1" },
      credential: { kind: "token" },
      active: false,
    };
    const approval: DecisionEvent = { ...event("9"), phase: "requested" };
    let captured: readonly unknown[] = [];
    await signDecisionBatch(
      [directory, approval],
      {
        async sign(payload) {
          // SAFETY: signDecisionBatch puts the event list in the payload's events field.
          captured = payload["events"] as readonly unknown[];
          return "jws";
        },
      },
      { source: "https://app.example.com" },
    );
    expect(captured).toMatchObject([
      { type: "com.permdock.directory.patched", subject: "u_1" },
      { type: "com.permdock.approval.requested", subject: "post.read" },
    ]);
  });

  it("builds membership events for scopes below the second level", () => {
    expect(
      membershipEvent({
        source: "cloud",
        operation: "added",
        principal: { id: "u_3" },
        scope: "site",
        id: "s_1",
        within: { organization: "o_1", customer: "c_1" },
        via: "contact",
        expiresAt: 1_790_000_000,
        roles: { added: ["technician"], removed: [] },
        at: "2026-09-29T10:00:00.000Z",
      }),
    ).toStrictEqual({
      type: "membership",
      at: "2026-09-29T10:00:00.000Z",
      source: "cloud",
      operation: "added",
      principal: { id: "u_3" },
      scope: "site",
      id: "s_1",
      within: { organization: "o_1", customer: "c_1" },
      via: "contact",
      expiresAt: "2026-09-21T14:13:20.000Z",
      roles: { added: ["technician"], removed: [] },
    });
    const base = {
      source: "app",
      operation: "changed",
      principal: { id: "u_3" },
      roles: { added: [], removed: [] },
    } as const;
    expect(() => membershipEvent({ ...base, scope: "site" })).toThrow(
      TypeError,
    );
    expect(() => membershipEvent({ ...base, id: "s_1" })).toThrow(TypeError);
    expect(() =>
      membershipEvent({ ...base, within: { organization: "o_1" } }),
    ).toThrow(TypeError);
    expect(() => membershipEvent({ ...base, at: "x" })).toThrow(RangeError);
    expect(() => membershipEvent({ ...base, expiresAt: "soon" })).toThrow(
      RangeError,
    );
    expect(
      membershipEvent({ ...base, expiresAt: "2026-10-01T00:00:00Z" }),
    ).toMatchObject({ expiresAt: "2026-10-01T00:00:00Z" });
    expect(membershipEvent(base)).not.toHaveProperty("scope");
  });

  it("envelopes membership events with principal id as subject", async () => {
    const membership = membershipEvent({
      source: "app",
      operation: "changed",
      principal: { id: "u_2" },
      scope: "tenant",
      id: "o_1",
      roles: { added: ["admin"], removed: ["member"] },
    });
    let captured: readonly unknown[] = [];
    await signDecisionBatch(
      [membership],
      {
        async sign(payload) {
          // SAFETY: signDecisionBatch puts the event list in the payload's events field.
          captured = payload["events"] as readonly unknown[];
          return "jws";
        },
      },
      { source: "https://app.example.com" },
    );
    expect(captured).toMatchObject([
      { type: "com.permdock.membership.changed", subject: "u_2" },
    ]);
  });
});

describe("toCloudEvent for access events", () => {
  it.each([
    { operation: "started", type: "com.permdock.support-session.started" },
    { operation: "ended", type: "com.permdock.support-session.ended" },
    { operation: "revoked", type: "com.permdock.support-session.ended" },
  ] as const)("types a $operation access event", ({ operation, type }) => {
    const cloud = toCloudEvent(
      accessEvent({
        source: "app",
        operation,
        tenant: "o1",
        principal: { id: "vendor-1" },
        roles: ["support"],
        at: "2026-01-01T00:00:00.000Z",
      }),
      { source: "https://app.example.com" },
    );
    expect({
      type: cloud.type,
      subject: cloud.subject,
      source: cloud.source,
      via:
        "type" in cloud.data && cloud.data.type === "access"
          ? cloud.data.via
          : undefined,
    }).toStrictEqual({
      type,
      subject: "vendor-1",
      source: "https://app.example.com",
      via: "support",
    });
  });
});

describe(toCloudEvent, () => {
  const source = "https://app.example.com";

  it.each([
    ["requested", "com.permdock.approval.requested"],
    ["resolved", "com.permdock.approval.resolved"],
    ["expired", "com.permdock.approval.expired"],
    ["cancelled", "com.permdock.approval.cancelled"],
  ] as const)("types a %s approval event", (phase, type) => {
    expect(toCloudEvent({ ...event("1"), phase }, { source }).type).toBe(type);
  });

  it.each([
    ["create", "com.permdock.directory.created"],
    ["replace", "com.permdock.directory.replaced"],
    ["patch", "com.permdock.directory.patched"],
    ["delete", "com.permdock.directory.deleted"],
  ] as const)("types a directory %s", (operation, type) => {
    const directory: DirectoryEvent = {
      type: "directory",
      at: "2026-01-01T00:00:00.000Z",
      source: "scim",
      operation,
      tenant: "o1",
      resource: { type: "Group", id: "g1" },
      credential: { kind: "jwt", iss: "https://idp.example.com" },
    };
    const cloud = toCloudEvent(directory, { source });
    expect([cloud.type, cloud.subject, cloud.dataschema]).toStrictEqual([
      type,
      "g1",
      "https://permdock.com/schemas/directory-event-v1.json",
    ]);
  });

  it.each([
    ["added", "com.permdock.membership.added"],
    ["removed", "com.permdock.membership.removed"],
  ] as const)("types a membership %s", (operation, type) => {
    const membership = membershipEvent({
      source: "app",
      operation,
      principal: { id: "u1" },
      roles: { added: [], removed: [] },
    });
    expect(toCloudEvent(membership, { source }).type).toBe(type);
  });

  it.each([
    ["created", "com.permdock.credential.created"],
    ["rotated", "com.permdock.credential.rotated"],
    ["revoked", "com.permdock.credential.revoked"],
  ] as const)("types a credential %s", (operation, type) => {
    const credential = credentialEvent({
      operation,
      credential: {
        v: 1,
        id: "k1",
        kind: "user",
        principal: "u1",
        permissions: [],
        createdBy: "u1",
        createdAt: "2026-09-21T13:46:40.000Z",
      },
    });
    expect(toCloudEvent(credential, { source }).type).toBe(type);
  });

  it("carries the id, traceparent and tracestate it is given", () => {
    const traceparent =
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    expect(
      toCloudEvent(event("1"), {
        source: "urn:uuid:7f1c9a52-0f4e-4d61-9c1a-3c3c1e1f0a10",
        id: "evt_1",
        traceparent,
        tracestate: "permdock=1",
      }),
    ).toMatchObject({
      id: "evt_1",
      source: "urn:uuid:7f1c9a52-0f4e-4d61-9c1a-3c3c1e1f0a10",
      traceparent,
      tracestate: "permdock=1",
    });
    expect(
      toCloudEvent(event("1"), { source, tracestate: "permdock=1" }),
    ).not.toHaveProperty("tracestate");
  });

  it("refuses a relative source and a malformed traceparent", () => {
    expect(() => toCloudEvent(event("1"), { source: "permdock" })).toThrow(
      TypeError,
    );
    for (const traceparent of [
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7",
      "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
    ]) {
      expect(() => toCloudEvent(event("1"), { source, traceparent })).toThrow(
        TypeError,
      );
    }
  });

  it("refuses a signing memoryDecisionSink without an absolute source", () => {
    expect(() =>
      memoryDecisionSink({
        signer: { sign: async () => "jws" },
        source: "app",
      }),
    ).toThrow(TypeError);
  });
});

describe(cloudEventType, () => {
  it("never throws for an operation outside its union", () => {
    const base = {
      at: "2026-01-01T00:00:00.000Z",
      source: "app",
      principal: { id: "u1" },
    };
    // SAFETY: each event carries an operation no producer emits, as a JavaScript caller could.
    const unknownEvents = [
      { ...event("1"), phase: "paused" },
      { ...base, type: "directory", operation: "merge" },
      { ...base, type: "membership", operation: "moved" },
      { ...base, type: "credential", operation: "lent" },
    ] as unknown as readonly Parameters<typeof cloudEventType>[0][];
    expect(unknownEvents.map((item) => cloudEventType(item))).toStrictEqual([
      "paused",
      "merge",
      "moved",
      "lent",
    ]);
  });
});
