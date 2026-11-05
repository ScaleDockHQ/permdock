import { describe, expect, it } from "vitest";

import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { expandSnapshot } from "../../src/core/snapshot-compact.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";

const base = {
  v: 1,
  issuedAt: "1970-01-01T00:00:00Z",
  subject: { principal: null, context: {} },
  roles: [],
  tenants: [],
  conditions: [{ effect: "allow", role: null, to: { kind: "authenticated" } }],
  grants: [{ permission: "post.read", cond: 0 }],
};

describe("compact snapshot guards", () => {
  it("expands a valid document", () => {
    const snapshot = expandSnapshot(parseSnapshot(JSON.stringify(base)));
    expect(snapshot.grants[0]).toStrictEqual({
      permission: "post.read",
      effect: "allow",
      role: null,
      to: { kind: "authenticated" },
    });
  });

  it.each([
    ["an index past the table", { permission: "post.read", cond: 1 }],
    ["a negative index", { permission: "post.read", cond: -1 }],
    ["a fractional index", { permission: "post.read", cond: 0.5 }],
    ["a string index", { permission: "post.read", cond: "0" }],
    ["a missing index", { permission: "post.read" }],
    ["a missing permission", { cond: 0 }],
    ["an empty list", { permission: "post.read", cond: [] }],
    ["a bad index in a list", { permission: "post.read", cond: [0, 4] }],
  ])("throws on %s", (_name, grant) => {
    expect(() =>
      parseSnapshot(JSON.stringify({ ...base, grants: [grant] })),
    ).toThrow(/PermDock: snapshot/u);
  });

  it("expands a list of indexes in order", () => {
    const snapshot = parseSnapshot(
      JSON.stringify({
        ...base,
        conditions: [
          ...base.conditions,
          { effect: "deny", role: null, to: { kind: "authenticated" } },
        ],
        grants: [{ permission: "post.read", cond: [0, 1, 0] }],
      }),
    );
    expect(
      expandSnapshot(snapshot).grants.map((grant) => grant.effect),
    ).toStrictEqual(["allow", "deny", "allow"]);
  });

  it("throws when conditions is not an array", () => {
    expect(() =>
      parseSnapshot(JSON.stringify({ ...base, conditions: {} })),
    ).toThrow(/conditions/u);
  });

  it("throws on an unknown version", () => {
    expect(() => parseSnapshot(JSON.stringify({ ...base, v: 3 }))).toThrow(
      /unsupported snapshot version/u,
    );
  });

  it("rejects a prototype key inside a condition", () => {
    const text = JSON.stringify(base).replace(
      '"role":null',
      '"role":null,"where":{"__proto__":{"eq":1}}',
    );
    expect(() => parseSnapshot(text)).toThrow(/snapshot/iu);
  });

  it("denies everything through an instance of a bad document's empty twin", () => {
    const empty = parseSnapshot(JSON.stringify({ ...base, grants: [] }));
    expect(fromSnapshot(empty).grantedPermissions()).toStrictEqual([]);
  });
});
