import { describe, expect, it } from "vitest";

import { readClaim } from "../../src/core/claims-map.ts";

describe(readClaim, () => {
  const claims = { sub: "u1", app: { roles: ["a"] } };

  it("reads a dot path, calls a function, and reads a throwing function as absent", () => {
    expect([
      readClaim(claims, "app.roles"),
      readClaim(claims, (value) => value["sub"]),
      readClaim(claims, () => {
        throw new Error("bad mapping");
      }),
      readClaim(claims, "__proto__.x"),
    ]).toStrictEqual([["a"], "u1", undefined, undefined]);
  });
});
