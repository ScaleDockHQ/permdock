import { describe, expect, it } from "vitest";

import { sameId } from "../../src/core/ids.ts";
import { createPermDock, fromSnapshot } from "../../src/core/permdock.ts";
import { normalizeMembership, scopeList } from "../../src/core/scopes.ts";
import { permissions, policy } from "../fixtures/named-scopes.ts";

const contact = {
  principal: {
    id: "u1",
    tenant: "T",
    memberships: [
      {
        scope: "customer",
        id: "42",
        within: { organization: "T" },
        roles: ["contact"],
        via: "contact",
      },
    ],
  },
  context: {},
};

describe("numeric scope ids", () => {
  it("matches a bigint key a client read as a number against the membership's text id", async () => {
    const permdock = await createPermDock(policy, contact);
    const asset = { id: "a", organization_id: "T", customer_id: 42 };
    expect(permdock.can(permissions.asset.read, asset, { trusted: true })).toBe(
      true,
    );
    expect(
      permdock.can(
        permissions.asset.read,
        { ...asset, customer_id: 43 },
        { trusted: true },
      ),
    ).toBe(false);
    expect(
      permdock
        .heldRoles({ scope: "customer", id: "42" })
        .map((role) => role.key),
    ).toEqual(["contact"]);
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("expected an unsigned snapshot");
    }
    expect(fromSnapshot(snapshot).can(permissions.asset.read, asset)).toBe(
      true,
    );
  });

  it("reads a numeric membership id as its decimal text", () => {
    const scopes = scopeList(policy.scopes);
    expect(
      normalizeMembership(
        {
          scope: "customer",
          id: 42,
          within: { organization: "T" },
          roles: ["contact"],
        },
        scopes,
      ),
    ).toMatchObject({ scope: "customer", id: "42" });
    expect(
      normalizeMembership(
        { scope: "customer", id: Number.POSITIVE_INFINITY, roles: ["x"] },
        scopes,
      ),
    ).toBeUndefined();
  });

  it("compares ids as text and never matches a missing one", () => {
    expect(sameId("42", 42)).toBe(true);
    expect(sameId(42n, "42")).toBe(true);
    expect(sameId("", "")).toBe(false);
    expect(sameId(undefined, undefined)).toBe(false);
    expect(sameId(null, "null")).toBe(false);
  });
});
