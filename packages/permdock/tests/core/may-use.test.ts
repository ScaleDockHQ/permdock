import { describe, expect, it } from "vitest";

import type { Snapshot, SnapshotGrant } from "../../src/core/interfaces.ts";
import type { PermDock } from "../../src/core/permdock.ts";

import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { mayAccess } from "../../src/core/may-access.ts";
import { mayUse } from "../../src/core/may-use.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, deny, role } from "../../src/core/policy.ts";
import { snapshotFor } from "../../src/core/snapshot-for.ts";
import { alice, policy as saas } from "../fixtures/saas.ts";

const permissions = definePermissions({
  doc: resource({ actions: ["read", "update"] }),
});

const member = { kind: "role", role: "member", scope: "global" } as const;
const read: SnapshotGrant = {
  permission: "doc.read",
  effect: "allow",
  role: "member",
  to: member,
};

function permdock(
  grants: readonly SnapshotGrant[],
  subject: Partial<Snapshot["subject"]> = {},
): PermDock {
  return fromSnapshot({
    v: 1,
    issuedAt: 1,
    subject: {
      principal: { id: "u1", roles: ["member"], tenant: "t1" },
      context: {},
      ...subject,
    },
    roles: ["member"],
    grants,
    tenants: ["t1"],
  });
}

describe("mayUse", () => {
  it("is true for an allow and false without one", () => {
    expect(mayUse(permdock([read]), permissions.doc.read)).toBe(true);
    expect(mayUse(permdock([read]), permissions.doc.update)).toBe(false);
  });

  it("is false under an unconditional deny, and true when the deny has a condition", () => {
    const blanket: SnapshotGrant = { ...read, effect: "deny" };
    expect(mayUse(permdock([read, blanket]), permissions.doc.read)).toBe(false);
    expect(
      mayUse(
        permdock([read, { ...blanket, scope: "tenant" }]),
        permissions.doc.read,
      ),
    ).toBe(false);
    for (const conditional of [
      { ...blanket, where: { op: "eq", field: "a", value: 1 } },
      { ...blanket, check: { op: "eq", field: "a", value: 1 } },
      { ...blanket, portable: false },
      { ...blanket, fields: ["secret"] },
      { ...blanket, scope: "team" },
    ] as const) {
      expect({
        conditional,
        may: mayUse(permdock([read, conditional]), permissions.doc.read),
      }).toEqual({ conditional, may: true });
    }
  });

  it("ignores grants of memberships in another tenant", () => {
    const elsewhere: SnapshotGrant = {
      ...read,
      scope: "tenant",
      membership: { scope: "tenant", id: "t2", roles: ["member"] },
    };
    const here: SnapshotGrant = {
      ...elsewhere,
      membership: { scope: "tenant", id: "t1", roles: ["member"] },
    };
    expect(mayUse(permdock([elsewhere]), permissions.doc.read)).toBe(false);
    expect(mayUse(permdock([here]), permissions.doc.read)).toBe(true);
  });

  it("is false when the delegation covers no row of the permission", () => {
    const scoped = (type: string) =>
      permdock([read], {
        delegation: {
          access: [{ type, actions: ["read"], identifier: "d1" }],
          authorizationDetails: [{ type, actions: ["read"] }],
        },
      });
    expect(mayUse(scoped("doc"), permissions.doc.read)).toBe(true);
    expect(mayUse(scoped("invoice"), permissions.doc.read)).toBe(false);
  });

  it("is false when the snapshot is not at hand or reading it throws", () => {
    const base = permdock([read]);
    const pending: PermDock = {
      ...base,
      // SAFETY: a foreign instance that breaks the overloads, to show mayUse stays closed.
      snapshot: (() =>
        Promise.resolve(
          "signed.snapshot.token",
        )) as unknown as PermDock["snapshot"],
    };
    expect(mayUse(pending, permissions.doc.read)).toBe(false);
    const broken: PermDock = {
      ...base,
      snapshot: () => {
        throw new Error("no snapshot");
      },
    };
    expect(mayUse(broken, permissions.doc.read)).toBe(false);
  });
});

describe("mayAccess", () => {
  const blanket = definePolicy(permissions, {
    roles: [
      role("member", [
        allow(permissions.doc.read),
        allow(permissions.doc.update),
      ]),
      role("banned", [deny(permissions.doc.read)]),
    ],
    subject: (user: {
      readonly id: string;
      readonly roles: readonly string[];
    }) => user,
  });

  it("is false under an unconditional deny of a held role", () => {
    expect(
      mayAccess(blanket, { id: "u1", roles: ["member"] }, permissions.doc.read),
    ).toBe(true);
    expect(
      mayAccess(
        blanket,
        { id: "u1", roles: ["member", "banned"] },
        permissions.doc.read,
      ),
    ).toBe(false);
  });

  it("is optimistic when the context mapper is asynchronous", () => {
    const later = definePolicy(permissions, {
      roles: [role("member", [])],
      subject: (user: { readonly id: string }) => ({ id: user.id, roles: [] }),
      context: async () => ({}),
    });
    expect(
      mayAccess(later, { id: "u1", roles: [] }, permissions.doc.read),
    ).toBe(true);
  });
});

describe("snapshotFor assignable", () => {
  it("narrows assignable roles per held tenant and leaves unlisted tenants empty", () => {
    const snapshot = snapshotFor(saas, alice, {
      tenant: "acme",
      tenants: "all",
      assignable: { acme: ["member"] },
    });
    expect(
      snapshot.assignable?.map((entry) => entry.tenant).toSorted(),
    ).toEqual(["acme", "globex"]);
    const roles = (tenant: string) =>
      snapshot.assignable?.find((entry) => entry.tenant === tenant)?.roles;
    expect(roles("acme")).toEqual(["member"]);
    expect(roles("globex")).toEqual([]);
  });
});
