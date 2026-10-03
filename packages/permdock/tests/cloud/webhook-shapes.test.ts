import { describe, expect, it, vi } from "vitest";

import type { TokenVerifier } from "../../src/core/interfaces.ts";
import type { ReplayStore } from "../../src/ssf/types.ts";

import { parseCloudEvent, verifyWebhook } from "../../src/cloud/webhook.ts";

const JWS = "aaa.bbb.ccc";
const RECEIVER = "https://hooks.example.com/permdock";

function envelope(
  type: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    specversion: "1.0",
    type,
    source: "https://api.permdock.test",
    id: "e1",
    time: "2026-09-28T10:00:00.000Z",
    datacontenttype: "application/json",
    data,
  };
}

const credential = {
  type: "credential",
  credential: { id: "k1", kind: "service" },
  principal: { id: "u1" },
  operation: "rotated",
};
const access = { type: "access", tenant: "o1", principal: { id: "u1" } };

describe("parseCloudEvent data shapes", () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    [
      "dev.permdock.decision",
      { type: "decision", permission: "post:read" },
      true,
    ],
    ["dev.permdock.decision", { type: "decision" }, false],
    [
      "dev.permdock.decision",
      { type: "directory", permission: "post:read" },
      false,
    ],
    ["dev.permdock.approval", { type: "decision", phase: "requested" }, true],
    ["dev.permdock.approval", { type: "decision", phase: "resolved" }, true],
    ["dev.permdock.approval", { type: "decision", phase: "other" }, false],
    ["dev.permdock.approval", { type: "access", phase: "requested" }, false],
    ["dev.permdock.directory", { type: "directory", tenant: "o1" }, true],
    ["dev.permdock.directory", { type: "directory" }, false],
    ["dev.permdock.directory", { type: "decision", tenant: "o1" }, false],
    ["dev.permdock.credential", credential, true],
    ["dev.permdock.credential", { ...credential, operation: "created" }, true],
    ["dev.permdock.credential", { ...credential, operation: "used" }, true],
    ["dev.permdock.credential", { ...credential, operation: "revoked" }, true],
    ["dev.permdock.credential", { ...credential, operation: "leaked" }, false],
    [
      "dev.permdock.credential",
      { ...credential, credential: { id: "k1", kind: "user" } },
      true,
    ],
    [
      "dev.permdock.credential",
      { ...credential, credential: { id: "k1", kind: "robot" } },
      false,
    ],
    [
      "dev.permdock.credential",
      { ...credential, credential: { kind: "user" } },
      false,
    ],
    ["dev.permdock.credential", { ...credential, credential: "k1" }, false],
    ["dev.permdock.credential", { ...credential, principal: "u1" }, false],
    ["dev.permdock.credential", { ...credential, type: "access" }, false],
    ["dev.permdock.access.started", access, true],
    ["dev.permdock.access.ended", access, true],
    ["dev.permdock.access.revoked", access, true],
    ["dev.permdock.access.started", { ...access, principal: { id: 1 } }, false],
    ["dev.permdock.access.started", { ...access, principal: null }, false],
    ["dev.permdock.access.started", { ...access, tenant: 1 }, false],
    ["dev.permdock.access.started", { ...access, type: "decision" }, false],
  ])("%s %j valid=%s", (type, data, valid) => {
    expect(parseCloudEvent(envelope(type, data)) !== null).toBe(valid);
  });
});

function verifierWith(
  result: Awaited<ReturnType<TokenVerifier["verify"]>> | Error,
): TokenVerifier {
  return {
    verify: async () => {
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

function claims(extra: Record<string, unknown>) {
  return { ok: true as const, header: { alg: "Ed25519" }, claims: extra };
}

const delivery = (): Request =>
  new Request(RECEIVER, { method: "POST", body: JWS });
const event = envelope("dev.permdock.directory", {
  type: "directory",
  tenant: "o1",
});

describe("verifyWebhook with an injected verifier", () => {
  it("refuses an unreadable body as unsigned", async () => {
    const request = delivery();
    await request.text();
    expect(
      await verifyWebhook(request, {
        audience: RECEIVER,
        verifier: verifierWith(claims({})),
      }),
    ).toEqual({
      ok: false,
      reason: "unsigned",
    });
  });

  it("reports a throwing verifier as malformed and passes its own cause through", async () => {
    expect(
      await verifyWebhook(delivery(), {
        audience: RECEIVER,
        verifier: verifierWith(new Error("x")),
      }),
    ).toEqual({ ok: false, reason: "invalid-token", cause: "malformed" });
    expect(
      await verifyWebhook(delivery(), {
        audience: RECEIVER,
        verifier: verifierWith({
          ok: false,
          reason: "invalid-token",
          cause: "expired",
        }),
      }),
    ).toEqual({ ok: false, reason: "invalid-token", cause: "expired" });
  });

  it.each<[string, Record<string, unknown>]>([
    ["no jti", { events: [event] }],
    ["events not an array", { jti: "j1", events: {} }],
    [
      "an invalid event",
      { jti: "j1", events: [event, { specversion: "1.0" }] },
    ],
  ])("refuses %s as invalid-events", async (_label, payload) => {
    expect(
      await verifyWebhook(delivery(), {
        audience: RECEIVER,
        verifier: verifierWith(claims(payload)),
      }),
    ).toEqual({ ok: false, reason: "invalid-events" });
  });

  it("drops a replay through seen and remember when the store has no claim", async () => {
    const seen = new Set<string>();
    const remember = vi.fn<(key: string, expiresAt?: number) => void>((key) => {
      seen.add(key);
    });
    const replay: ReplayStore = { seen: (key) => seen.has(key), remember };
    const verifier = verifierWith(
      claims({ jti: "j1", exp: 2_000_000_000, events: [event] }),
    );
    const first = await verifyWebhook(delivery(), {
      audience: RECEIVER,
      verifier,
      replay,
    });
    expect(first).toMatchObject({
      ok: true,
      id: "j1",
      events: [{ type: "dev.permdock.directory" }],
    });
    expect(remember).toHaveBeenCalledWith("permdock-webhook:j1", 2_000_000_000);
    expect(
      await verifyWebhook(delivery(), { audience: RECEIVER, verifier, replay }),
    ).toEqual({
      ok: false,
      reason: "replayed",
    });
  });

  it("fails closed as replayed when the replay store throws", async () => {
    const replay: ReplayStore = {
      seen: () => {
        throw new Error("redis down");
      },
      remember: () => undefined,
    };
    const verifier = verifierWith(claims({ jti: "j1", events: [] }));
    expect(
      await verifyWebhook(delivery(), { audience: RECEIVER, verifier, replay }),
    ).toEqual({
      ok: false,
      reason: "replayed",
    });
  });
});
