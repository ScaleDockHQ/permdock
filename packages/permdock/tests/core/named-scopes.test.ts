import { describe, expect, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";
import type { Permission } from "../../src/core/permissions.ts";
import type { Membership, Principal } from "../../src/core/subject.ts";

import { pushedPolicy } from "../../src/cli/cloud.ts";
import { evaluateCondition } from "../../src/conditions/evaluate.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { memoryRoleSource } from "../../src/core/interfaces.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import { reasonOf } from "../fixtures/decisions.ts";
import {
  assets,
  customRoles,
  documents,
  permissions,
  personas,
  policy,
} from "../fixtures/named-scopes.ts";

async function permdockFor(
  principal: Principal,
  options: { readonly tenant?: string } = {},
): Promise<PermDock> {
  return createPermDock(policy, principal, {
    customRoles: memoryRoleSource(customRoles),
    ...options,
  });
}

const rowsFor = (permission: Permission): readonly object[] =>
  permission.resource === "asset" ? assets : documents;

// SAFETY: every leaf of these three resources is a Permission from definePermissions.
const instanceLeaves = [
  ...Object.values(permissions.quote),
  ...Object.values(permissions.invoice),
  ...Object.values(permissions.asset),
] as readonly Permission[];

function readable(permdock: PermDock, permission: Permission): string[] {
  // SAFETY: callers pass instance leaves, and every asset and document row has a string id.
  return rowsFor(permission)
    .filter((row) => permdock.can(permission as never, row))
    .map((row) => (row as { readonly id: string }).id);
}

describe("named scopes: decide, snapshot and where agree", () => {
  for (const [name, principal] of Object.entries(personas)) {
    it(`agrees for ${name}`, async () => {
      const permdock = await permdockFor(principal);
      const snapshot = permdock.snapshot();
      if (snapshot instanceof Promise) {
        throw new TypeError("expected an unsigned snapshot");
      }
      const client = fromSnapshot(parseSnapshot(JSON.stringify(snapshot)));
      for (const permission of instanceLeaves) {
        const where = permdock.where(permission);
        for (const row of rowsFor(permission)) {
          // SAFETY: instanceLeaves holds only instance permissions.
          const decided = permdock.can(permission as never, row);
          // SAFETY: instanceLeaves holds only instance permissions.
          expect(
            client.can(permission as never, row),
            `${name} snapshot ${permission.key} ${JSON.stringify(row)}`,
          ).toBe(decided);
          if (!where.partial) {
            expect(
              evaluateCondition(
                where.condition,
                row,
                permdock.subject,
                undefined,
                where.scopes,
              ),
              `${name} where ${permission.key} ${JSON.stringify(row)}`,
            ).toBe(decided);
          }
        }
      }
    });
  }
});

describe("named scopes: the scenario", () => {
  it("shows a portal contact only their customer's sent documents", async () => {
    const permdock = await permdockFor(personas.privateContact);
    expect(readable(permdock, permissions.quote.read)).toEqual([
      "d_a_sent",
      "d_a_accepted",
    ]);
    expect(readable(permdock, permissions.quote.accept)).toEqual(["d_a_sent"]);
    expect(readable(permdock, permissions.quote.update)).toEqual([]);
    const business = await permdockFor(personas.businessContact);
    expect(readable(business, permissions.invoice.read)).toEqual(["d_g_sent"]);
  });

  it("gives an owner every quote of the active organization and no customer reach", async () => {
    const permdock = await permdockFor(personas.owner);
    expect(readable(permdock, permissions.quote.read)).toEqual([
      "d_a_sent",
      "d_a_draft",
      "d_a_accepted",
      "d_g_sent",
    ]);
    expect(
      permdock.memberships().filter((item) => item.scope === "customer"),
    ).toEqual([]);
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("expected an unsigned snapshot");
    }
    expect(
      new Set(
        snapshot.grants
          .filter((grant) => grant.permission === "quote.read")
          .map((grant) => grant.scope),
      ),
    ).toEqual(new Set(["organization"]));
    expect(permdock.where(permissions.quote.read).condition).toEqual({
      op: "eq",
      field: "organization_id",
      value: "T",
    });
    expect(readable(permdock.tenant("B"), permissions.quote.read)).toEqual([
      "d_c_sent",
      "d_b_draft",
    ]);
  });

  it("keeps a viewer to reading their own organization", async () => {
    const permdock = await permdockFor(personas.viewer);
    expect(readable(permdock, permissions.quote.read)).toEqual([
      "d_c_sent",
      "d_b_draft",
    ]);
    expect(readable(permdock, permissions.quote.update)).toEqual([]);
    expect(
      permdock.tenant("T").can(permissions.quote.read, documents[0]!),
    ).toBe(false);
  });

  it("lets each membership of a staff member who is also a contact grant only in its own scope", async () => {
    const permdock = await permdockFor(personas.staffContact);
    expect(permdock.subject.principal?.tenant).toBe("T");
    expect(permdock.tenants()).toEqual(["T", "B"]);
    expect(readable(permdock, permissions.quote.read)).toEqual([
      "d_a_sent",
      "d_a_draft",
      "d_a_accepted",
      "d_g_sent",
    ]);
    const portal = permdock.tenant("B");
    expect(readable(portal, permissions.quote.read)).toEqual(["d_c_sent"]);
    expect(readable(portal, permissions.quote.update)).toEqual([]);
    expect(portal.decide(permissions.quote.read, documents[5]!).outcome).toBe(
      "denied",
    );
  });

  it("answers an instance check without a row from the first scope only", async () => {
    const contact = await permdockFor(personas.privateContact);
    for (const permission of [permissions.asset.read, permissions.quote.read]) {
      const decision = contact.decide(permission, undefined);
      expect(decision.outcome).toBe("denied");
      expect(reasonOf(decision)).toBe("scope");
    }
    const client = fromSnapshot(
      parseSnapshot(JSON.stringify(contact.snapshot())),
    );
    expect(client.can(permissions.asset.read, undefined)).toBe(false);
    expect(contact.can(permissions.asset.read, assets[0]!)).toBe(true);
    expect(contact.team("A").can(permissions.asset.read, undefined)).toBe(true);
    expect(contact.team("G").can(permissions.asset.read, undefined)).toBe(
      false,
    );

    const staff = await permdockFor(personas.admin);
    expect(staff.can(permissions.asset.read, undefined)).toBe(true);

    const both = await permdockFor(personas.staffContact);
    expect(both.can(permissions.asset.read, undefined)).toBe(true);
    expect(both.tenant("B").can(permissions.asset.read, undefined)).toBe(false);
    expect(
      both.tenant("B").team("C").can(permissions.asset.read, undefined),
    ).toBe(true);
  });

  it("gives platform operators system permissions and no tenant data", async () => {
    const admin = await permdockFor(personas.platformAdmin);
    expect(admin.can(permissions.organization.disable, { id: "T" })).toBe(true);
    expect(admin.can(permissions.organization.list)).toBe(true);
    for (const leaf of instanceLeaves) {
      expect(readable(admin, leaf)).toEqual([]);
    }
    expect(admin.where(permissions.quote.read).condition).toEqual({
      op: "or",
      conditions: [],
    });
    const support = await permdockFor(personas.platformSupport);
    expect(support.can(permissions.organization.disable, { id: "T" })).toBe(
      false,
    );
  });

  it("applies org T's custom role and its tenant deny", async () => {
    const permdock = await permdockFor(personas.mechanic);
    expect(readable(permdock, permissions.asset.update)).toEqual([
      "a_a_sent",
      "a_a_draft",
      "a_a_accepted",
      "a_g_sent",
    ]);
    expect(readable(permdock, permissions.asset.delete)).toEqual([]);
    expect(readable(permdock, permissions.quote.read)).toEqual([]);
  });

  it("blocks every path into a suspended organization through the membership source", async () => {
    const disabled = new Set(["T"]);
    const active = (list: readonly Membership[] = []): Membership[] =>
      list.filter(
        (item) =>
          !disabled.has(item.scope === "organization" ? (item.id ?? "") : "") &&
          !disabled.has(item.within?.["organization"] ?? ""),
      );
    for (const principal of [
      personas.owner,
      personas.privateContact,
      personas.staffContact,
    ]) {
      const permdock = await createPermDock(policy, principal, {
        memberships: {
          membershipsFor: () => active(principal.memberships),
        },
      });
      expect(readable(permdock, permissions.quote.read)).toEqual([]);
      expect(permdock.where(permissions.quote.read).condition).toEqual({
        op: "or",
        conditions: [],
      });
    }
  });
});

describe("named scopes: permissions a suspended organization keeps", () => {
  const keep = (list: readonly Membership[] = []): Membership[] =>
    list.map((item) =>
      (item.scope === "organization"
        ? item.id
        : item.within?.["organization"]) === "T"
        ? { ...item, keep: ["invoice.read"] }
        : item,
    );

  it("holds only the kept permissions through a suspended instance", async () => {
    for (const principal of [personas.owner, personas.privateContact]) {
      const permdock = await createPermDock(policy, principal, {
        memberships: { membershipsFor: () => keep(principal.memberships) },
      });
      expect(readable(permdock, permissions.quote.read)).toEqual([]);
      expect(readable(permdock, permissions.asset.read)).toEqual([]);
      expect(readable(permdock, permissions.invoice.read)).not.toEqual([]);
      expect(permdock.where(permissions.quote.read).condition).toEqual({
        op: "or",
        conditions: [],
      });
      const snapshot = permdock.snapshot();
      if (snapshot instanceof Promise) {
        throw new TypeError("expected an unsigned snapshot");
      }
      const client = fromSnapshot(parseSnapshot(JSON.stringify(snapshot)));
      expect(readable(client, permissions.quote.read)).toEqual([]);
      expect(readable(client, permissions.invoice.read)).toEqual(
        readable(permdock, permissions.invoice.read),
      );
    }
    const owner = await createPermDock(policy, personas.owner, {
      memberships: { membershipsFor: () => keep(personas.owner.memberships) },
    });
    expect(owner.heldRoles()).toEqual([]);
    expect(
      owner
        .tenant("B")
        .heldRoles()
        .map((item) => item.key),
    ).toEqual(["owner"]);
  });

  it("drops a membership whose keep is not a list of keys", async () => {
    const permdock = await createPermDock(policy, personas.privateContact, {
      memberships: {
        membershipsFor: () => {
          const out: Membership[] = [];
          for (const item of personas.privateContact.memberships ?? []) {
            // SAFETY: a malformed keep from an untrusted source, which normalisation must refuse.
            out.push({ ...item, keep: "invoice.read" as unknown as string[] });
          }
          return out;
        },
      },
    });
    expect(readable(permdock, permissions.invoice.read)).toEqual([]);
  });
});

describe("named scopes: snapshot scope list", () => {
  it("denies a scoped grant whose scope the snapshot does not list", async () => {
    const permdock = await permdockFor(personas.privateContact);
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("expected an unsigned snapshot");
    }
    const { scopes: _dropped, ...stripped } = snapshot;
    const client = fromSnapshot(parseSnapshot(JSON.stringify(stripped)));
    expect(client.can(permissions.quote.read, documents[0]!)).toBe(false);
    expect(client.where(permissions.quote.read).condition).toEqual({
      op: "or",
      conditions: [],
    });
    expect(
      fromSnapshot(parseSnapshot(JSON.stringify(snapshot))).can(
        permissions.quote.read,
        documents[0]!,
      ),
    ).toBe(true);
  });

  it("pushes the scopes to the Cloud as a snapshot carries them", async () => {
    const permdock = await permdockFor(personas.owner);
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("expected an unsigned snapshot");
    }
    expect(pushedPolicy(policy).scopes).toEqual(snapshot.scopes);
    expect(pushedPolicy(policy).scopes?.[1]).toEqual({
      name: "customer",
      key: "customer_id",
      within: "organization",
      resources: ["quote", "invoice", "asset"],
    });
  });
});

describe("named scopes: no implicit cascade", () => {
  it("never lets a customer membership satisfy an organization role, or the reverse", async () => {
    const crossed = await permdockFor({
      id: "u_x",
      tenant: "T",
      memberships: [
        {
          scope: "customer",
          id: "A",
          within: { organization: "T" },
          roles: ["owner"],
        },
        { scope: "organization", id: "T", roles: ["contact"] },
      ],
    });
    for (const leaf of instanceLeaves) {
      expect(readable(crossed, leaf)).toEqual([]);
    }
  });

  it("drops a nested membership without its parent id", async () => {
    const permdock = await permdockFor({
      id: "u_x",
      tenant: "T",
      memberships: [{ scope: "customer", id: "A", roles: ["contact"] }],
    });
    expect(permdock.memberships()).toEqual([]);
  });

  it("accepts tenant and team aliases for the first two scopes", async () => {
    const permdock = await permdockFor({
      id: "u_alias",
      tenant: "T",
      memberships: [
        { tenant: "T", team: "A", roles: ["contact"], via: "contact" },
        { tenant: "T", roles: ["viewer"], via: "staff" },
      ],
    });
    expect(permdock.memberships()).toEqual([
      {
        scope: "customer",
        id: "A",
        within: { organization: "T" },
        roles: ["contact"],
        via: "contact",
      },
      { scope: "organization", id: "T", roles: ["viewer"], via: "staff" },
    ]);
    const aliased = definePolicy(permissions, {
      scopes: {
        organization: { key: "organization_id" },
        customer: { key: "customer_id", within: "organization" },
      },
      subject: (user: Principal | null) => user,
      roles: [role("reader", [allow(permissions.quote.read)], { on: "team" })],
    });
    expect(aliased.grants[0]?.scope).toBe("customer");
  });
});

describe("named scopes: definition", () => {
  const tree = definePermissions({
    doc: resource({
      actions: ["read"],
      relations: { ws: { field: "workspace_id", memberOf: "workspace" } },
    }),
  });
  const subject = (user: Principal | null) => user;

  it("rejects a parent declared later, an unknown one and reserved names", () => {
    expect(() =>
      definePolicy(tree, {
        subject,
        scopes: {
          workspace: { key: "workspace_id", within: "organization" },
          organization: { key: "organization_id" },
        },
      }),
    ).toThrow(/not declared before it/);
    expect(() =>
      definePolicy(tree, {
        subject,
        scopes: { global: { key: "x" } },
      }),
    ).toThrow(/scope name 'global'/);
    expect(() =>
      definePolicy(tree, {
        subject,
        scopes: { organization: { key: "o" }, tenant: { key: "t" } },
      }),
    ).toThrow(/'tenant' must be declared first/);
    expect(() =>
      definePolicy(tree, {
        subject,
        scopes: { tenant: { key: "orgId" }, team: { key: "teamId" } },
      }),
    ).toThrow(/scopes.team needs within/);
    expect(() =>
      definePolicy(tree, {
        subject,
        scopes: { organization: { key: "o" }, region: { key: "r" } },
      }),
    ).toThrow(/scopes.region needs within/);
    expect(() =>
      definePolicy(tree, {
        subject,
        scopes: { organization: { key: "" } },
      }),
    ).toThrow(/needs a key/);
  });

  it("requires the scope key on every resource an instance grant touches", () => {
    expect(() =>
      definePolicy(tree, {
        subject,
        scopes: { organization: { key: "organization_id" } },
        roles: [role("reader", [allow(tree.doc.read)], { on: "organization" })],
      }),
    ).toThrow(/doc.read on 'organization' roles/);
    expect(
      definePolicy(tree, {
        subject,
        scopes: {
          organization: { key: "organization_id" },
          workspace: { key: "workspace_id", within: "organization" },
        },
        roles: [role("reader", [allow(tree.doc.read)], { on: "workspace" })],
      }).scopes.map((scope) => scope.name),
    ).toEqual(["organization", "workspace"]);
  });

  it("reserves the restricted role option", () => {
    // SAFETY: a deliberately reserved option, to exercise role()'s refusal.
    expect(() => role("x", [], { restricted: undefined as never })).toThrow(
      /reserved/,
    );
  });
});
