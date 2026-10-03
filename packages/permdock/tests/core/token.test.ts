import { describe, expect, it } from "vitest";

import {
  decisionToken,
  payloadDigest,
  versionOf,
} from "../../src/core/token.ts";

describe("decisionToken", () => {
  it("prefixes pd1 and is stable for the same inputs", () => {
    const input = {
      key: "post.update",
      resourceId: "p1",
      principal: { id: "u1", roles: ["member"] as const },
      actor: undefined,
      fingerprint: "fp",
    };
    const token = decisionToken(input);
    expect(token.startsWith("pd1.")).toBe(true);
    expect(decisionToken(input)).toBe(token);
    expect(
      decisionToken({
        ...input,
        principal: { id: "u1", roles: ["member"], binding: { kid: "k" } },
      }),
    ).toBe(token);
  });
});

describe("versionOf", () => {
  it.each([
    [null, null],
    ["row", null],
    [{}, null],
    [{ version: "v3" }, "v3"],
    [{ version: 3 }, "3"],
    [{ version: 3n }, "3"],
    [{ version: false }, "false"],
    [{ version: new Date(0) }, "1970-01-01T00:00:00.000Z"],
    [{ version: new Date("invalid") }, null],
    [{ version: { nested: 1 } }, null],
    [Object.create({ version: "inherited" }), null],
  ])("reads %o as %o", (row, expected) => {
    expect(versionOf(row, "version")).toBe(expected);
  });
});

describe("payloadDigest", () => {
  it("is stable across key order and differs across values", () => {
    expect(payloadDigest({ a: 1, b: 2 })).toBe(payloadDigest({ b: 2, a: 1 }));
    expect(payloadDigest({ a: 1 })).not.toBe(payloadDigest({ a: 2 }));
  });
});
