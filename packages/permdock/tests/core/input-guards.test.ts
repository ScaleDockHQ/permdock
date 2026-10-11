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
    expect(compact<{ readonly a: number }>({ a: 1, b: undefined })).toEqual({
      a: 1,
    });
    expect(() => parseSnapshot([])).toThrow(/must be an object/);
    expect(() =>
      parseSnapshot({ v: 1, nested: { __proto__: {} } }),
    ).not.toThrow();
    const hashed = bytesToBase64Url(sha256("hello"));
    expect(hashed.length).toBeGreaterThan(10);
    expect(parseSnapshot({ v: 1, grants: [] }).v).toBe(1);
  });
});
