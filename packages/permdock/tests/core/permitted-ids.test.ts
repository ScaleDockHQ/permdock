import { describe, expect, it } from "vitest";

import { createPermDock, fromSnapshot } from "../../src/core/permdock.ts";
import { permittedIds } from "../../src/index.ts";
import { customRoles, permissions, policy } from "../fixtures/named-scopes.ts";

const contact = {
  principal: {
    id: "c1",
    memberships: [
      {
        scope: "customer",
        id: "A",
        within: { organization: "T" },
        roles: ["contact"],
        via: "contact",
      },
      {
        scope: "customer",
        id: "B",
        within: { organization: "U" },
        roles: ["contact"],
        via: "contact",
      },
      {
        scope: "customer",
        id: "C",
        within: { organization: "T" },
        roles: ["contact"],
        via: "contact",
        expiresAt: 1,
      },
    ],
  },
  context: {},
};

describe("permittedIds", () => {
  it("lists the instances an unconditional allow reaches, across tenants or within one", async () => {
    const permdock = await createPermDock(policy, contact);
    expect(permittedIds(permdock, permissions.asset.read, "customer")).toEqual([
      "A",
      "B",
    ]);
    expect(
      permittedIds(permdock, permissions.asset.read, "customer", {
        within: "T",
      }),
    ).toEqual(["A"]);
    expect(permittedIds(permdock, permissions.quote.read, "customer")).toEqual(
      [],
    );
    expect(permittedIds(permdock, permissions.asset.read, "region")).toEqual(
      [],
    );
  });

  it("leaves out an instance a deny reaches and follows a snapshot", async () => {
    const staff = await createPermDock(
      policy,
      {
        principal: {
          id: "s1",
          memberships: [
            {
              scope: "organization",
              id: "T",
              roles: ["mechanic"],
              via: "staff",
            },
            { scope: "organization", id: "U", roles: ["admin"], via: "staff" },
          ],
        },
        context: {},
      },
      {
        customRoles: {
          rolesFor: (tenant) =>
            customRoles.filter((role) => role.tenant === tenant),
        },
      },
    );
    expect(permittedIds(staff, permissions.quote.read, "organization")).toEqual(
      ["U"],
    );
    expect(permittedIds(staff, permissions.asset.read, "organization")).toEqual(
      ["T", "U"],
    );
    const snapshot = staff.snapshot({ tenants: "all" });
    if (snapshot instanceof Promise) {
      throw new TypeError("expected an unsigned snapshot");
    }
    expect(
      permittedIds(
        fromSnapshot(snapshot),
        permissions.asset.read,
        "organization",
      ),
    ).toEqual(["T", "U"]);
  });

  it("lists nothing for an actor whose delegation does not cover the permission", async () => {
    const permdock = await createPermDock(policy, {
      ...contact,
      actor: { id: "bot", kind: "agent" },
      delegation: { scopes: ["quote:read"] },
    });
    expect(permittedIds(permdock, permissions.asset.read, "customer")).toEqual(
      [],
    );
  });
});
