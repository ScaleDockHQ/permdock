import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";

import type { SinkEvent } from "../../src/core/event-types.ts";

import { parseCloudEvent, verifyWebhook } from "../../src/cloud/webhook.ts";
import {
  CLOUDEVENTS_BATCH_CONTENT_TYPE,
  CLOUD_EVENT_TYPES,
  toCloudEvent,
} from "../../src/core/sink.ts";
import { webhookSigner } from "../../src/server/standard-webhooks.ts";
import { memoryReplayStore } from "../../src/ssf/replay.ts";

const PRIVATE_JWK = {
  crv: "Ed25519",
  d: "qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4",
  x: "79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ",
  kty: "OKP",
  kid: "2026-09",
};
const { d: _d, ...PUBLIC_JWK } = PRIVATE_JWK;
const JWKS = { keys: [PUBLIC_JWK] };
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const RECEIVER = "https://hooks.example.com/permdock";
const SOURCE = "https://api.permdock.test/v1/environments/production";

const signer = webhookSigner({
  keys: [{ alg: "v1a", privateKey: PRIVATE_JWK }],
});

const membership: SinkEvent = {
  type: "membership",
  at: "2026-09-28T10:00:00.000Z",
  source: "cloud",
  operation: "changed",
  principal: { id: "u_1" },
  roles: { added: ["admin"], removed: [] },
};

let sequence = 0;

async function delivery(
  body: unknown,
  options: { readonly id?: string; readonly sign?: typeof signer } = {},
): Promise<Request> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  sequence += 1;
  const headers = await (options.sign ?? signer).sign({
    id: options.id ?? `msg_${String(sequence)}`,
    body: text,
    now: Temporal.Now.instant(),
  });
  return new Request(RECEIVER, {
    method: "POST",
    headers: { ...headers, "content-type": CLOUDEVENTS_BATCH_CONTENT_TYPE },
    body: text,
  });
}

const catalog = (data: Record<string, unknown>): Record<string, unknown> => ({
  specversion: "1.0",
  type:
    data["kind"] === "drift"
      ? CLOUD_EVENT_TYPES.catalogDrifted
      : CLOUD_EVENT_TYPES.catalogPublished,
  source: SOURCE,
  subject: "cat_2",
  id: "evt_1",
  time: "2026-09-28T10:00:00.000Z",
  datacontenttype: "application/json",
  dataschema: "https://permdock.com/schemas/catalog-event-v1.json",
  data,
});

describe("verifyWebhook", () => {
  it("accepts a v1a-signed CloudEvents batch", async () => {
    const result = await verifyWebhook(
      await delivery([toCloudEvent(membership, { source: SOURCE })], {
        id: "msg_batch",
      }),
      { jwks: JWKS, replay: memoryReplayStore() },
    );
    expect(result).toMatchObject({
      ok: true,
      id: "msg_batch",
      events: [{ type: CLOUD_EVENT_TYPES.membershipChanged, source: SOURCE }],
    });
  });

  it("accepts a single v1-signed CloudEvent", async () => {
    const result = await verifyWebhook(
      await delivery(toCloudEvent(membership, { source: SOURCE }), {
        sign: webhookSigner({ keys: [{ alg: "v1", secret: SECRET }] }),
      }),
      { secret: SECRET, replay: memoryReplayStore() },
    );
    expect(result.ok ? result.events.length : 0).toBe(1);
  });

  it("carries catalog events with typed drift findings", async () => {
    const replay = memoryReplayStore();
    const published = await verifyWebhook(
      await delivery([
        catalog({ kind: "publish", fingerprint: "cat_2", previous: "cat_1" }),
      ]),
      { jwks: JWKS, replay },
    );
    expect(
      published.ok &&
        published.events[0]?.type === CLOUD_EVENT_TYPES.catalogPublished
        ? published.events[0].data.previous
        : undefined,
    ).toBe("cat_1");
    const drift = (findings: readonly unknown[]) =>
      delivery([catalog({ kind: "drift", fingerprint: "cat_2", findings })]);
    const typed = await verifyWebhook(
      await drift([
        { code: "not-hostable", permission: "auditLog.read", grant: "g_1" },
        { code: "permission-removed", permission: "invoice.export" },
      ]),
      { jwks: JWKS, replay },
    );
    expect(
      typed.ok && typed.events[0]?.type === CLOUD_EVENT_TYPES.catalogDrifted
        ? typed.events[0].data.findings?.[0]?.code
        : undefined,
    ).toBe("not-hostable");
    for (const findings of [
      ["auditLog.read is no longer hostable"],
      [{ code: "renamed", permission: "a.b" }],
    ]) {
      expect(
        await verifyWebhook(await drift(findings), { jwks: JWKS, replay }),
      ).toEqual({ ok: false, cause: "invalid-events" });
    }
  });

  it("has no unsigned mode", async () => {
    const plain = new Request(RECEIVER, {
      method: "POST",
      body: JSON.stringify([toCloudEvent(membership, { source: SOURCE })]),
    });
    expect(
      await verifyWebhook(plain, { jwks: JWKS, replay: memoryReplayStore() }),
    ).toEqual({ ok: false, cause: "missing-headers" });
  });

  it("needs keys and a replay store", async () => {
    const request = await delivery([]);
    expect(await verifyWebhook(request, { jwks: JWKS })).toEqual({
      ok: false,
      cause: "keys-unavailable",
    });
    expect(
      await verifyWebhook(request, { replay: memoryReplayStore() }),
    ).toMatchObject({ ok: false, cause: "keys-unavailable" });
    expect(
      await verifyWebhook(request, {
        secret: "whsec_",
        replay: memoryReplayStore(),
      }),
    ).toMatchObject({ ok: false, cause: "keys-unavailable" });
  });

  it("rejects another key, a stale timestamp and a tampered body", async () => {
    const other = webhookSigner({ keys: [{ alg: "v1", secret: SECRET }] });
    expect(
      await verifyWebhook(await delivery([], { sign: other }), {
        jwks: JWKS,
        replay: memoryReplayStore(),
      }),
    ).toEqual({ ok: false, cause: "invalid-signature" });
    expect(
      await verifyWebhook(await delivery([]), {
        jwks: JWKS,
        replay: memoryReplayStore(),
        now: () => Temporal.Now.instant().add({ minutes: 6 }),
      }),
    ).toEqual({ ok: false, cause: "timestamp-out-of-range" });
    const signed = await delivery([]);
    const tampered = new Request(signed, { method: "POST", body: "[ ]" });
    expect(
      await verifyWebhook(tampered, {
        jwks: JWKS,
        replay: memoryReplayStore(),
      }),
    ).toMatchObject({ ok: false, cause: "invalid-signature" });
  });

  it("rejects an unknown event type, a non-JSON body and a replayed delivery", async () => {
    const replay = memoryReplayStore();
    const unknown = {
      ...toCloudEvent(membership, { source: SOURCE }),
      type: "com.permdock.grant",
    };
    expect(
      await verifyWebhook(await delivery([unknown]), { jwks: JWKS, replay }),
    ).toEqual({ ok: false, cause: "invalid-events" });
    expect(
      await verifyWebhook(await delivery("not json"), { jwks: JWKS, replay }),
    ).toEqual({ ok: false, cause: "invalid-events" });
    const body = [toCloudEvent(membership, { source: SOURCE })];
    const verifier = { jwks: JWKS, replay };
    const first = await verifyWebhook(
      await delivery(body, { id: "msg_once" }),
      verifier,
    );
    const second = await verifyWebhook(
      await delivery(body, { id: "msg_once" }),
      verifier,
    );
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, cause: "replayed" });
  });

  it("reuses an injected verifier", async () => {
    const result = await verifyWebhook(await delivery([]), {
      verifier: {
        verify: async () => ({
          ok: true,
          id: "msg_x",
          timestamp: "2026-09-28T10:00:00Z",
          body: "[]",
        }),
      },
    });
    expect(result).toEqual({
      ok: true,
      id: "msg_x",
      timestamp: "2026-09-28T10:00:00Z",
      events: [],
    });
  });
});

describe("parseCloudEvent", () => {
  it("validates the envelope, the type and the data shape", () => {
    const event = toCloudEvent(membership, { source: SOURCE });
    expect(parseCloudEvent(event)?.type).toBe(
      CLOUD_EVENT_TYPES.membershipChanged,
    );
    expect(parseCloudEvent({ ...event, specversion: "0.3" })).toBeNull();
    expect(
      parseCloudEvent({ ...event, type: CLOUD_EVENT_TYPES.catalogPublished }),
    ).toBeNull();
    expect(
      parseCloudEvent(
        JSON.parse(
          `{"specversion":"1.0","type":"com.permdock.catalog.drifted","source":"https://a.example","id":"i","time":"2026-01-01T00:00:00Z","dataschema":"https://permdock.com/schemas/catalog-event-v1.json","data":{"kind":"drift","fingerprint":"f","__proto__":{}}}`,
        ),
      ),
    ).toBeNull();
  });
});
