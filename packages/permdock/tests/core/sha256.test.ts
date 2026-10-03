import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { bytesToBase64Url, sha256 } from "../../src/core/sha256.ts";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("sha256", () => {
  it("matches the published digest of abc", () => {
    expect(hex(sha256("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches Node crypto for empty and longer strings", () => {
    for (const message of ["", "hello", "a".repeat(200)]) {
      const expected = createHash("sha256").update(message).digest("hex");
      expect(hex(sha256(message))).toBe(expected);
    }
  });

  it("encodes base64url without padding", () => {
    expect(bytesToBase64Url(sha256("abc"))).not.toMatch(/[+/=]/);
  });
});
