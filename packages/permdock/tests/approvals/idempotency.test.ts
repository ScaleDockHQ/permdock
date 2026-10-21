import { describe, expect, it } from "vitest";

import {
  idempotencyRecord,
  idempotencyRecordKey,
  matchesIdempotencyRecord,
  memoryIdempotencyStore,
} from "../../src/approvals/index.ts";
import { sha256Digest } from "../../src/index.ts";
import { testIdempotencyStore } from "../../src/testing/index.ts";

describe("idempotencyRecord", () => {
  const call = { action: "approve", id: "apr_1", body: "" } as const;

  it("builds the record the approvals handler stores", async () => {
    const record = await idempotencyRecord({
      principalId: "u_1",
      key: "k1",
      call,
      response: new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      now: 1000,
    });
    expect(record).toStrictEqual({
      key: "u_1\nk1",
      response: {
        fingerprint: `approve apr_1 ${sha256Digest("")}`,
        status: 200,
        headers: [["content-type", "application/json"]],
        body: '{"ok":true}',
      },
      expiresAt: 1000 + 24 * 60 * 60 * 1000,
    });
    expect(idempotencyRecordKey("u_1", "k1")).toBe(record.key);
    expect(matchesIdempotencyRecord(record.response, call)).toBe(true);
    expect(
      matchesIdempotencyRecord(record.response, { ...call, action: "reject" }),
    ).toBe(false);
    expect(
      matchesIdempotencyRecord(record.response, { ...call, body: "{}" }),
    ).toBe(false);
  });
});

describe("memoryIdempotencyStore conformance", () => {
  testIdempotencyStore(memoryIdempotencyStore());
});

describe("memoryIdempotencyStore", () => {
  it("drops an entry once it expires", () => {
    const store = memoryIdempotencyStore();
    const response = {
      fingerprint: "approve apr_1 sha-256:abc",
      status: 200,
      headers: [],
      body: "{}",
    };
    store.set("expired", response, Date.now() - 1);
    expect(store.get("expired")).toBeUndefined();
    expect(store.get("expired")).toBeUndefined();
  });
});
