import { describe, expect, it } from "vitest";

import { createPermDock, fromSnapshot } from "../../src/core/permdock.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  permittedIds,
  resource,
  role,
} from "../../src/index.ts";
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
            customRoles.filter((custom) => custom.tenant === tenant),
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

  it("lists conditioned allows only on request, and then subtracts only unconditional denies", async () => {
    const permdock = await createPermDock(policy, contact);
    expect(
      permittedIds(permdock, permissions.quote.read, "customer", {
        conditioned: true,
      }),
    ).toEqual(["A", "B"]);
    expect(
      permittedIds(permdock, permissions.quote.accept, "customer", {
        conditioned: true,
        within: "U",
      }),
    ).toEqual(["B"]);
  });
});

describe("permittedIds over fields, validity and conditioned denies", () => {
  const tree = definePermissions({
    note: resource({
      id: "id",
      actions: ["read"],
      relations: { team: { field: "team_id", memberOf: "group" } },
    }),
  });
  const notes = definePolicy(tree, {
    scopes: { group: { key: "team_id" } },
    roles: [
      role(
        "reader",
        [
          allow(tree.note.read, { fields: ["title"] }),
          deny(tree.note.read, { where: { secret: true } }),
        ],
        { on: "group" },
      ),
      role("timed", [allow(tree.note.read, { validUntil: 4_102_444_800 })], {
        on: "group",
      }),
      role("blocked", [allow(tree.note.read), deny(tree.note.read)], {
        on: "group",
      }),
    ],
    // SAFETY: the tests pass a full Subject, so the mapper never runs.
    subject: (user: unknown) => user as never,
  });
  const member = (team: string, roleName: string) => ({
    scope: "group",
    id: team,
    roles: [roleName],
  });

  it("counts a field-limited allow as unconditional, a validity window as a condition, and a conditioned deny only by default", async () => {
    const permdock = await createPermDock(notes, {
      principal: {
        id: "u1",
        memberships: [
          member("t1", "reader"),
          member("t2", "timed"),
          member("t3", "blocked"),
        ],
      },
      context: {},
    });
    expect(permittedIds(permdock, tree.note.read, "group")).toEqual([]);
    expect(
      permittedIds(permdock, tree.note.read, "group", { conditioned: true }),
    ).toEqual(["t1", "t2"]);
    const fieldsOnly = await createPermDock(
      definePolicy(tree, {
        scopes: { group: { key: "team_id" } },
        roles: [
          role("reader", [allow(tree.note.read, { fields: ["title"] })], {
            on: "group",
          }),
        ],
        // SAFETY: the tests pass a full Subject, so the mapper never runs.
        subject: (user: unknown) => user as never,
      }),
      {
        principal: { id: "u1", memberships: [member("t1", "reader")] },
        context: {},
      },
    );
    expect(permittedIds(fieldsOnly, tree.note.read, "group")).toEqual(["t1"]);
  });
});
