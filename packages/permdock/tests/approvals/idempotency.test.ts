import { describe, expect, it } from "vitest";

import { memoryIdempotencyStore } from "../../src/approvals/index.ts";
import { testIdempotencyStore } from "../../src/testing/index.ts";

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
