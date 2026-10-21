import { describe, expect, it } from "vitest";

import { compact } from "../../src/core/compact.ts";
import { freezeDeep } from "../../src/core/freeze.ts";
import { readPath } from "../../src/core/paths.ts";
import { sha256, bytesToBase64Url } from "../../src/core/sha256.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import { isPrincipal, isSubject } from "../../src/core/subject.ts";

describe("input guards", () => {
  it("subject guards, path reads, compact, freeze and snapshot parsing fail closed on malformed input", () => {
    expect(isPrincipal([])).toBe(false);
    expect(isPrincipal({ id: 1 })).toBe(false);
    expect(isSubject({ principal: null, context: "nope" })).toBe(false);
    expect(isSubject(null)).toBe(false);
    freezeDeep(() => undefined);
    expect(readPath({ a: null }, "a.b")).toBeUndefined();
    expect(
      compact<{ readonly a: number }>({ a: 1, b: undefined }),
    ).toStrictEqual({ a: 1 });
    expect(() => parseSnapshot([])).toThrow(/must be an object/u);
    expect(() =>
      parseSnapshot({
        v: 1,
        issuedAt: "2026-10-13T09:00:00Z",
        nested: { __proto__: {} },
      }),
    ).not.toThrow();
    const hashed = bytesToBase64Url(sha256("hello"));
    expect(hashed.length).toBeGreaterThan(10);
    const issuedAt = "2026-10-13T09:00:00Z";
    expect(parseSnapshot({ v: 1, issuedAt, grants: [] }).v).toBe(1);
    expect(() => parseSnapshot({ v: 1, issuedAt: 1, grants: [] })).toThrow(
      /RFC 3339/u,
    );
    expect(() =>
      parseSnapshot({ v: 1, issuedAt, expiresAt: "tomorrow", grants: [] }),
    ).toThrow(/RFC 3339/u);
  });
});
