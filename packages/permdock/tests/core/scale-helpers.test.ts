import { describe, expect, it } from "vitest";

import type { Subject } from "../../src/index.ts";

import {
  allow,
  definePermissions,
  definePolicy,
  fromSnapshot,
  getPermDockSync,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  organization: resource({
    id: "id",
    actions: ["read", "update"],
    relations: { self: { field: "id", memberOf: "organization" } },
  }),
  project: resource({
    id: "id",
    actions: ["read"],
    relations: { org: { field: "organization_id", memberOf: "organization" } },
  }),
  tool: resource({ id: "id", actions: ["read", "write", "export"] }),
});

const policy = definePolicy(permissions, {
  scopes: { organization: { key: "organization_id" } },
  roles: [
    role(
      "admin",
      [
        allow([
          permissions.organization.read,
          permissions.organization.update,
          permissions.project.read,
        ]),
      ],
      { on: "organization" },
    ),
    role("viewer", [allow([permissions.organization.read])], {
      on: "organization",
    }),
  ],
  subject: () => null,
});

const subject: Subject = {
  principal: {
    id: "u1",
    tenant: "T",
    memberships: [
      { scope: "organization", id: "T", roles: ["admin"] },
      { scope: "organization", id: "U", roles: ["admin"] },
      { scope: "organization", id: "V", roles: ["viewer"] },
    ],
  },
  context: {},
};

const permdock = getPermDockSync(policy, subject);

describe("permittedScopeIds", () => {
  it("lists the instances of the permission's scope in the active tenant by default", () => {
    expect(permdock.permittedScopeIds(permissions.project.read)).toStrictEqual([
      "T",
    ]);
  });

  it("takes the tenant it is asked for, and lists nothing for one the subject does not hold", () => {
    expect(
      permdock.permittedScopeIds(permissions.project.read, { tenant: "U" }),
    ).toStrictEqual(["U"]);
    expect(
      permdock.permittedScopeIds(permissions.project.read, { tenant: "V" }),
    ).toStrictEqual([]);
    expect(
      permdock.permittedScopeIds(permissions.project.read, { tenant: "Z" }),
    ).toStrictEqual([]);
  });

  it("lists every held instance for a subject with no active tenant", () => {
    const none = getPermDockSync(policy, {
      ...subject,
      principal: {
        id: "u1",
        memberships: subject.principal?.memberships ?? [],
      },
    });
    expect(none.permittedScopeIds(permissions.organization.read)).toStrictEqual(
      ["T", "U", "V"],
    );
  });

  it("answers what permittedIds answers for the permission's scope", () => {
    expect(
      permdock.permittedScopeIds(permissions.organization.read, {
        tenant: "U",
      }),
    ).toStrictEqual(
      permdock.permittedIds(permissions.organization.read, "organization", {
        within: "U",
      }),
    );
  });

  it("is the same on an instance built from a snapshot", () => {
    const local = fromSnapshot(permdock.snapshot({ tenants: "all" }));
    expect(
      local.permittedIds(permissions.project.read, "organization", {
        within: "U",
      }),
    ).toStrictEqual(["U"]);
    expect(
      local.permittedScopeIds(permissions.project.read, { tenant: "U" }),
    ).toStrictEqual(["U"]);
  });
});

describe("mayUseMany", () => {
  it("answers each permission in order, as mayUse does", () => {
    const list = [
      permissions.organization.update,
      permissions.tool.read,
      permissions.project.read,
      permissions.organization.update,
    ];
    expect(permdock.mayUseMany(list)).toStrictEqual(
      list.map((permission) => permdock.mayUse(permission)),
    );
    expect(permdock.mayUseMany(list)).toStrictEqual([true, false, true, true]);
  });

  it("answers a 300-tool listing as 300 single answers", () => {
    const many = Array.from({ length: 300 }, (_, index) =>
      index % 2 === 0 ? permissions.organization.update : permissions.tool.read,
    );
    expect(permdock.mayUseMany(many)).toStrictEqual(
      many.map((permission) => permdock.mayUse(permission)),
    );
  });

  it("answers an empty list with an empty list", () => {
    expect(permdock.mayUseMany([])).toStrictEqual([]);
  });
});

describe("filterIds", () => {
  it("keeps the ids of the scope instances the subject holds the permission on", () => {
    expect(
      permdock.filterIds(permissions.organization.update, ["T", "X", "U", "V"]),
    ).toStrictEqual(["T", "U"]);
    expect(
      permdock.filterIds(permissions.organization.read, ["V", "T", "X"]),
    ).toStrictEqual(["V", "T"]);
  });

  it("keeps the order of the ids and drops a repeated one", () => {
    expect(
      permdock.filterIds(permissions.organization.read, ["V", "T", "V"]),
    ).toStrictEqual(["V", "T"]);
  });

  it("keeps nothing for a resource whose id is not a scope instance, which needs its rows", () => {
    expect(
      permdock.filterIds(permissions.project.read, ["T", "p1"]),
    ).toStrictEqual([]);
  });

  it("answers an empty list with an empty list", () => {
    expect(permdock.filterIds(permissions.organization.read, [])).toStrictEqual(
      [],
    );
  });
});

describe("where with a tenant", () => {
  it("compiles for the tenant it is given, as that tenant's instance does", () => {
    const given = permdock.where(permissions.project.read, { tenant: "U" });
    const preview = permdock.tenant("U").where(permissions.project.read);
    expect(given.condition).toStrictEqual(preview.condition);
    expect(given.condition).not.toStrictEqual(
      permdock.where(permissions.project.read).condition,
    );
    expect(given.subject?.principal?.tenant).toBe("U");
  });

  it("denies every row for a tenant the subject does not hold", () => {
    const given = permdock.where(permissions.project.read, { tenant: "Z" });
    expect(given.condition).toStrictEqual(
      permdock.tenant("Z").where(permissions.project.read).condition,
    );
  });

  it("keeps the active tenant without the option", () => {
    expect(permdock.where(permissions.project.read).condition).toStrictEqual(
      permdock.where(permissions.project.read, {}).condition,
    );
  });

  it("is the same on an instance built from a snapshot", () => {
    const local = fromSnapshot(permdock.snapshot({ tenants: "all" }));
    expect(
      local.where(permissions.project.read, { tenant: "U" }).condition,
    ).toStrictEqual(
      permdock.where(permissions.project.read, { tenant: "U" }).condition,
    );
  });
});
