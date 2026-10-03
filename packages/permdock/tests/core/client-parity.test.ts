import { describe, expect, it } from "vitest";

import type { Principal } from "../../src/core/subject.ts";

import { evaluateCondition } from "../../src/conditions/evaluate.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { memoryRoleSource } from "../../src/core/interfaces.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, deny, role } from "../../src/core/policy.ts";
import { crud } from "../../src/core/presets.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import { defineRoles } from "../../src/core/vocabulary.ts";
import { reasonOf } from "../fixtures/decisions.ts";

type Row = {
  readonly id: string;
  readonly orgId: string;
  readonly teamId: string | null;
  readonly locked: boolean;
};

const permissions = definePermissions({
  project: resource(
    crud({
      relations: {
        org: { field: "orgId", memberOf: "tenant" },
        team: { field: "teamId", memberOf: "team" },
      },
    }),
  ),
  member: resource({ collection: ["list"] }),
  note: resource({
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const roles = defineRoles({
  admin: { on: "tenant", assignable: true },
  viewer: { on: "tenant", assignable: true },
  lead: { on: "team", assignable: true },
});

const policy = definePolicy(
  { permissions, roles },
  {
    scopes: {
      tenant: { key: "orgId" },
      team: { key: "teamId", within: "tenant" },
    },
    subject: (user: Principal | null) => user,
    roles: [
      role(roles.lead, [
        allow(permissions.project.update, { to: roles.lead }),
        deny(permissions.project.update, (row: Row) => row.locked),
      ]),
    ],
    grants: [
      allow(permissions.project.read, { to: roles.viewer }),
      allow(permissions.project.read, { to: roles.admin }),
      allow(permissions.project.update, { to: roles.admin }),
      allow(permissions.project.create, { to: roles.admin }),
      allow(permissions.member.list, { to: roles.admin }),
      allow(permissions.note.read, { to: roles.viewer }),
    ],
  },
);

const acme: Row = { id: "a1", orgId: "acme", teamId: "t1", locked: false };
const acmeLocked: Row = { ...acme, id: "a2", locked: true };
const acmeOtherTeam: Row = { ...acme, id: "a3", teamId: "t2" };
const globex: Row = { id: "g1", orgId: "globex", teamId: null, locked: false };

const alice: Principal = {
  id: "alice",
  memberships: [
    { tenant: "acme", roles: ["admin"] },
    { tenant: "globex", roles: ["viewer"] },
  ],
};
const erin: Principal = {
  id: "erin",
  memberships: [
    { tenant: "acme", roles: ["admin"] },
    { tenant: "globex", roles: ["admin"] },
  ],
};
const gina: Principal = {
  id: "gina",
  memberships: [{ tenant: "acme", team: "t1", roles: ["lead"] }],
};
const dave: Principal = {
  id: "dave",
  memberships: [{ tenant: "acme", roles: ["contractor"] }],
};

async function both(user: Principal, tenant: string) {
  const server = await createPermDock(policy, user, {
    tenant,
    customRoles: memoryRoleSource([
      { tenant: "acme", name: "contractor", includes: ["viewer"] },
      { tenant: "globex", name: "contractor", includes: ["admin"] },
    ]),
  });
  const client = fromSnapshot(parseSnapshot(JSON.stringify(server.snapshot())));
  return { server, client };
}

const matches = (
  condition: Parameters<typeof evaluateCondition>[0],
  row: Row,
  user: Principal,
) =>
  evaluateCondition(
    condition,
    row,
    { principal: user, context: {} },
    1_700_000_000,
  );

describe("client parity", () => {
  it("checks the tenant of a proposed row on create and on an update move", async () => {
    const { server, client } = await both(alice, "acme");
    for (const permdock of [server, client]) {
      expect(permdock.can(permissions.project.create, acme)).toBe(true);
      expect(permdock.can(permissions.project.create, globex)).toBe(false);
      expect(permdock.can(permissions.project.create)).toBe(true);
      expect(
        permdock.can(permissions.project.update, {
          current: acme,
          next: { ...acme, orgId: "globex" },
        }),
      ).toBe(false);
      expect(
        permdock.can(permissions.project.update, {
          current: acme,
          next: { ...acme, locked: true },
        }),
      ).toBe(true);
    }
    expect(reasonOf(server.decide(permissions.project.create, globex))).toBe(
      "tenant-mismatch",
    );
  });

  it("attaches snapshot grants to every membership holding the role", async () => {
    const { server, client } = await both(erin, "globex");
    expect(server.can(permissions.member.list)).toBe(true);
    expect(client.can(permissions.member.list)).toBe(true);
    expect(client.can(permissions.project.update, globex)).toBe(true);
  });

  it("checks the row tenant on the client", async () => {
    const { server, client } = await both(alice, "acme");
    expect(server.can(permissions.project.read, globex)).toBe(false);
    expect(client.can(permissions.project.read, globex)).toBe(false);
    expect(client.can(permissions.project.read, acme)).toBe(true);
  });

  it("checks the row team on the client", async () => {
    const { server, client } = await both(gina, "acme");
    expect(server.can(permissions.project.update, acmeOtherTeam)).toBe(false);
    expect(client.can(permissions.project.update, acmeOtherTeam)).toBe(false);
  });

  it("fails closed on a non-portable deny the client cannot evaluate", async () => {
    const { server, client } = await both(gina, "acme");
    expect(server.can(permissions.project.update, acme)).toBe(true);
    expect(server.can(permissions.project.update, acmeLocked)).toBe(false);
    expect(client.can(permissions.project.update, acmeLocked)).toBe(false);
    expect(client.can(permissions.project.update, acme)).toBe(false);
  });

  it("expands custom roles per membership and per tenant only", async () => {
    const { server, client } = await both(dave, "acme");
    expect(server.can(permissions.project.read, acme)).toBe(true);
    expect(client.can(permissions.project.read, acme)).toBe(true);
    expect(server.can(permissions.project.update, acme)).toBe(false);
    expect(client.can(permissions.project.update, acme)).toBe(false);
  });

  it("denies a tenant-related row that has no tenant field", async () => {
    const { server, client } = await both(alice, "acme");
    // SAFETY: deliberately a Row without its tenant field, to exercise the fail-closed deny.
    const orphan = { id: "x", teamId: null, locked: false } as unknown as Row;
    expect(server.can(permissions.project.read, orphan)).toBe(false);
    expect(client.can(permissions.project.read, orphan)).toBe(false);
  });

  it("rejects a tenant grant on a resource without the tenant key", () => {
    const loose = definePermissions({ memo: resource({ actions: ["read"] }) });
    expect(() =>
      definePolicy(loose, {
        scopes: { tenant: { key: "orgId" } },
        subject: (user: Principal | null) => user,
        roles: [role("viewer", [allow(loose.memo.read)], { on: "tenant" })],
      }),
    ).toThrow(/memo.read on 'tenant' roles/);
  });

  it("reports only global roles when no tenant is active", async () => {
    const server = await createPermDock(policy, {
      ...alice,
      roles: ["support"],
    });
    expect(server.heldRoles().map((item) => item.key)).toEqual(["support"]);
    expect(
      server.heldRoles({ tenant: "globex" }).map((item) => item.key),
    ).toEqual(["support", "viewer"]);
  });
});

describe("where() tenant scope", () => {
  it("scopes tenant grants to the active tenant", async () => {
    const { server } = await both(alice, "acme");
    const { condition, partial } = server.where(permissions.project.update);
    expect(partial).toBe(false);
    expect(matches(condition, acme, alice)).toBe(true);
    expect(matches(condition, globex, alice)).toBe(false);
  });

  it("returns nothing for tenant grants without an active tenant", async () => {
    const server = await createPermDock(policy, alice);
    expect(server.where(permissions.project.read).condition).toEqual({
      op: "or",
      conditions: [],
    });
  });

  it("scopes team grants to the membership team and keeps closures partial", async () => {
    const { server } = await both(gina, "acme");
    const { condition, partial } = server.where(permissions.project.update);
    expect(partial).toBe(true);
    expect(matches(condition, acme, gina)).toBe(true);
    expect(matches(condition, acmeOtherTeam, gina)).toBe(false);
  });

  it("empties the result for an unconditional deny", async () => {
    const blocked = definePolicy(
      { permissions, roles },
      {
        scopes: { tenant: { key: "orgId" } },
        subject: (user: Principal | null) => user,
        grants: [
          allow(permissions.project.read, { to: roles.admin }),
          deny(permissions.project.read, { to: roles.admin }),
        ],
      },
    );
    const server = await createPermDock(blocked, alice, { tenant: "acme" });
    expect(server.can(permissions.project.read, acme)).toBe(false);
    expect(server.where(permissions.project.read).condition).toEqual({
      op: "or",
      conditions: [],
    });
  });
});
