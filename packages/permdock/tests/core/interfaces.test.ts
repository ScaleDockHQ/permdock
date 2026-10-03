import { describe, expect, it } from "vitest";

import { memoryEntitlementSource } from "../../src/core/interfaces.ts";

describe("memoryEntitlementSource", () => {
  const source = memoryEntitlementSource({ acme: ["sso"] });
  const principal = { id: "u1" };

  it.each([
    { name: "a known tenant", tenant: "acme", entitlements: ["sso"] },
    { name: "an unknown tenant", tenant: "globex", entitlements: [] },
    { name: "no tenant", tenant: undefined, entitlements: [] },
  ])("lists the entitlements of $name", ({ tenant, entitlements }) => {
    expect(
      source.entitlementsFor(principal, tenant === undefined ? {} : { tenant }),
    ).toEqual(entitlements);
  });
});
