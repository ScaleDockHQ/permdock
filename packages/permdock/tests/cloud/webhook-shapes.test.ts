import { describe, expect, it } from "vitest";

import type {
  VerifiedWebhookMessage,
  WebhookFailureCause,
  WebhookVerifier,
} from "../../src/server/standard-webhooks.ts";

import { parseCloudEvent, verifyWebhook } from "../../src/cloud/webhook.ts";
import { EVENT_SCHEMA_IDS } from "../../src/core/event-schemas.ts";
import { CLOUD_EVENT_TYPES } from "../../src/core/sink.ts";

const RECEIVER = "https://hooks.example.com/permdock";

function envelope(
  type: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const family =
    typeof data["type"] === "string" && data["type"] in EVENT_SCHEMA_IDS
      ? data["type"]
      : "decision";
  return {
    specversion: "1.0",
    type,
    source: "https://api.permdock.test",
    id: "e1",
    time: "2026-09-28T10:00:00.000Z",
    datacontenttype: "application/json",
    dataschema: `https://permdock.com/schemas/${family}-event-v1.json`,
    data,
  };
}

const credential = {
  type: "credential",
  at: "2026-09-28T10:00:00.000Z",
  source: "cloud",
  credential: { id: "k1", kind: "service" },
  principal: { id: "u1" },
  operation: "rotated",
};
const access = {
  type: "access",
  at: "2026-09-28T10:00:00.000Z",
  source: "cloud",
  operation: "started",
  tenant: "o1",
  principal: { id: "u1" },
  via: "support",
  roles: ["support"],
};
const directory = {
  type: "directory",
  at: "2026-09-28T10:00:00.000Z",
  source: "scim",
  operation: "patch",
  tenant: "o1",
  resource: { type: "User", id: "u1" },
  credential: { kind: "token" },
};

describe("parseCloudEvent data shapes", () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    [CLOUD_EVENT_TYPES.directoryPatched, directory, true],
    [CLOUD_EVENT_TYPES.directoryCreated, directory, false],
    [CLOUD_EVENT_TYPES.directoryPatched, { ...directory, tenant: 1 }, false],
    [CLOUD_EVENT_TYPES.credentialRotated, credential, true],
    [
      CLOUD_EVENT_TYPES.credentialCreated,
      { ...credential, operation: "created" },
      true,
    ],
    [
      CLOUD_EVENT_TYPES.credentialRotated,
      { ...credential, operation: "leaked" },
      false,
    ],
    [
      CLOUD_EVENT_TYPES.credentialRotated,
      { ...credential, credential: { id: "k1", kind: "robot" } },
      false,
    ],
    [
      CLOUD_EVENT_TYPES.credentialRotated,
      { ...credential, credential: { kind: "user" } },
      false,
    ],
    [
      CLOUD_EVENT_TYPES.credentialRotated,
      { ...credential, principal: "u1" },
      false,
    ],
    [CLOUD_EVENT_TYPES.supportSessionStarted, access, true],
    [
      CLOUD_EVENT_TYPES.supportSessionEnded,
      { ...access, operation: "revoked" },
      true,
    ],
    [CLOUD_EVENT_TYPES.supportSessionEnded, access, false],
    [
      CLOUD_EVENT_TYPES.supportSessionStarted,
      { ...access, principal: { id: 1 } },
      false,
    ],
    [
      CLOUD_EVENT_TYPES.supportSessionStarted,
      { ...access, principal: null },
      false,
    ],
  ])("%s %j valid=%s", (type, data, valid) => {
    expect(parseCloudEvent(envelope(type, data)) !== null).toBe(valid);
  });
});

function verifierWith(result: VerifiedWebhookMessage): WebhookVerifier {
  return { verify: async () => result };
}

const delivery = (): Request =>
  new Request(RECEIVER, { method: "POST", body: "[]" });

describe("verifyWebhook with an injected verifier", () => {
  it.each<WebhookFailureCause>([
    "missing-headers",
    "malformed",
    "timestamp-out-of-range",
    "invalid-signature",
    "keys-unavailable",
    "replayed",
  ])("passes the verifier cause %s through", async (cause) => {
    expect(
      await verifyWebhook(delivery(), {
        verifier: verifierWith({ ok: false, cause }),
      }),
    ).toEqual({ ok: false, cause });
  });

  it.each<[string, string]>([
    ["an object that is not an event", "{}"],
    [
      "a batch with one invalid event",
      `[${JSON.stringify(envelope(CLOUD_EVENT_TYPES.directoryPatched, directory))},{"specversion":"1.0"}]`,
    ],
  ])("refuses %s as invalid-events", async (_label, body) => {
    expect(
      await verifyWebhook(delivery(), {
        verifier: verifierWith({
          ok: true,
          id: "msg_1",
          timestamp: "2026-09-28T10:00:00Z",
          body,
        }),
      }),
    ).toEqual({ ok: false, cause: "invalid-events" });
  });
});
