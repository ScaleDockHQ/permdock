import { describe, expect, it } from "vitest";

import type { CustomRole, Membership } from "../../src/core/subject.ts";

import { principal } from "../../src/conditions/refs.ts";
import {
  customRoleClaim,
  resolveCustomRole,
  validateCustomRole,
} from "../../src/core/custom-roles.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { memoryRoleSource } from "../../src/core/interfaces.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import {
  definePermissions,
  listPermissions,
  resource,
} from "../../src/core/permissions.ts";
import { allow, definePolicy, deny, role } from "../../src/core/policy.ts";
import { snapshotFor } from "../../src/core/snapshot-for.ts";
import { defineRoles } from "../../src/core/vocabulary.ts";
import { decideLeaf } from "../fixtures/decisions.ts";

const permissions = definePermissions({
  invoice: resource({
    id: "id",
    actions: ["read", "pay", "refund", "void"],
    collection: ["create"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  post: resource({
    id: "id",
    actions: ["read", "update", "archive"],
    collection: ["create"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  member: resource({
    collection: { invite: {}, assignRole: { manageRoles: true } },
  }),
  board: resource({
    id: "id",
    actions: ["read", "edit"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      team: { field: "teamId", memberOf: "team" },
    },
  }),
});

const roles = defineRoles({
  owner: { on: "tenant", assignable: false },
  admin: { on: "tenant" },
  billing: { on: "tenant" },
  editor: { on: "tenant" },
  viewer: { on: "tenant" },
  steward: { on: "tenant", meta: { manageRoles: true } },
  lead: { on: "team" },
});

const policy = definePolicy(
  { permissions, roles },
  {
    scopes: {
      tenant: { key: "orgId" },
      team: { key: "teamId", within: "tenant" },
    },
    subject: (user: { readonly id: string } | null) =>
      user === null ? null : { id: user.id },
    roles: [
      role(roles.owner, [
        allow(permissions.invoice.void),
        allow(permissions.member.assignRole),
      ]),
      role(roles.admin, [
        allow(permissions.invoice.read),
        allow(permissions.post.read),
        allow(permissions.post.update),
        allow(permissions.post.create),
        allow(permissions.member.invite),
      ]),
      role(roles.billing, [
        allow(permissions.invoice.read),
        allow(permissions.invoice.pay, { approval: "human" }),
        allow(permissions.invoice.refund),
        deny(permissions.invoice.refund, { where: { amount: { gt: 1000 } } }),
      ]),
      role(roles.editor, [
        allow(permissions.post.read),
        allow(permissions.post.create),
        allow(permissions.post.update, { where: { authorId: principal.id } }),
      ]),
      role(roles.viewer, [
        allow(permissions.post.read),
        allow(permissions.invoice.read),
      ]),
      role(roles.steward, []),
      role(roles.lead, [
        allow(permissions.board.read),
        allow(permissions.board.edit),
      ]),
    ],
  },
);

const invoice = { id: "i1", orgId: "acme", amount: 50 };
const bigInvoice = { id: "i2", orgId: "acme", amount: 5000 };
const foreignInvoice = { id: "i3", orgId: "globex", amount: 50 };
const ownPost = { id: "p1", orgId: "acme", authorId: "u1" };
const otherPost = { id: "p2", orgId: "acme", authorId: "u9" };
const board = { id: "b1", orgId: "acme", teamId: "t1" };
const otherBoard = { id: "b2", orgId: "acme", teamId: "t2" };

function subjectIn(memberships: readonly Membership[], tenant = "acme") {
  return {
    principal: { id: "u1", memberships, tenant },
    context: {},
  };
}

async function permdockFor(
  memberships: readonly Membership[],
  customRoles: readonly CustomRole[],
  tenant = "acme",
) {
  return createPermDock(policy, subjectIn(memberships, tenant), {
    tenant,
    customRoles: memoryRoleSource(customRoles),
  });
}

describe("resolveCustomRole", () => {
  it("unions includes and own allows, removes denies, within the ceiling", () => {
    const resolved = resolveCustomRole(policy, {
      tenant: "acme",
      name: "accounts",
      includes: ["billing"],
      grants: [
        { permission: "post.read" },
        { permission: "invoice.refund", effect: "deny" },
      ],
    });
    const keys = resolved.grants.map(
      (grant) => `${grant.effect}:${grant.permission.key}`,
    );
    expect(keys).toContain("allow:invoice.read");
    expect(keys).toContain("allow:invoice.pay");
    expect(keys).toContain("allow:post.read");
    expect(keys).not.toContain("allow:invoice.refund");
    expect(keys).toContain("deny:invoice.refund");
    expect(resolved.dropped).toEqual([]);
    for (const grant of resolved.grants) {
      expect(grant.role).toBe("accounts");
      expect(grant.scope).toBe("tenant");
    }
    const pay = resolved.grants.find(
      (grant) => grant.permission.key === "invoice.pay",
    );
    expect(pay?.approval).toBe("human");
  });

  it("reports every dropped entry with its reason", () => {
    const resolved = resolveCustomRole(policy, {
      tenant: "acme",
      name: "grabby",
      includes: ["owner", "ghost"],
      grants: [
        { permission: "invoice.void" },
        { permission: "nope.read" },
        // SAFETY: a deliberately conditional grant, which resolveCustomRole must drop.
        {
          permission: "post.update",
          where: { authorId: "x" },
        } as unknown as { permission: string },
      ],
    });
    expect(resolved.dropped).toEqual([
      { permission: "invoice.void", reason: "outside-ceiling" },
      { permission: "member.assignRole", reason: "outside-ceiling" },
      { role: "ghost", reason: "unknown-role" },
      { permission: "nope.read", reason: "unknown-permission" },
      { permission: "post.update", reason: "condition-not-allowed" },
    ]);
    expect(resolved.grants).toEqual([]);
  });

  it("validateCustomRole lists the effective permissions", () => {
    expect(
      validateCustomRole(policy, {
        tenant: "acme",
        name: "reader",
        grants: [{ permission: "post.read" }, { permission: "invoice.read" }],
      }),
    ).toEqual({
      ok: true,
      permissions: ["invoice.read", "post.read"],
      dropped: [],
      renamed: [],
    });
    expect(
      validateCustomRole(policy, {
        tenant: "acme",
        name: "x",
        grants: [{ permission: "invoice.void" }],
      }).ok,
    ).toBe(false);
  });

  it("keeps only the included denies of its own scope", () => {
    const resolved = resolveCustomRole(policy, {
      tenant: "acme",
      team: "t1",
      name: "team-billing",
      includes: ["billing", "lead"],
    });
    expect(resolved.grants.map((grant) => grant.permission.key)).toEqual([
      "board.read",
      "board.edit",
    ]);
  });

  it("customRoleClaim writes the compact grants map", () => {
    expect(
      customRoleClaim([
        {
          tenant: "acme",
          name: "clerk",
          includes: ["billing"],
          grants: [
            { permission: "post.read" },
            { permission: "invoice.refund", effect: "deny" },
          ],
        },
        { tenant: "acme", name: "__proto__", grants: [] },
      ]),
    ).toEqual({ clerk: ["@billing", "post.read", "-invoice.refund"] });
  });

  it("bounds a team custom role by the team ceiling", () => {
    const resolved = resolveCustomRole(policy, {
      tenant: "acme",
      team: "t1",
      name: "reviewer",
      grants: [{ permission: "board.read" }, { permission: "post.read" }],
    });
    expect(resolved.grants.map((grant) => grant.permission.key)).toEqual([
      "board.read",
    ]);
    expect(resolved.grants[0]?.scope).toBe("team");
    expect(resolved.dropped).toEqual([
      { permission: "post.read", reason: "outside-ceiling" },
    ]);
  });
});

describe("custom roles in decisions", () => {
  it("inherits the declared condition of an included role", async () => {
    const permdock = await permdockFor(
      [{ tenant: "acme", roles: ["writer"] }],
      [{ tenant: "acme", name: "writer", includes: ["editor"] }],
    );
    expect(permdock.can(permissions.post.update, ownPost)).toBe(true);
    expect(permdock.can(permissions.post.update, otherPost)).toBe(false);
  });

  it("an own allow reaches every ceiling grant of the permission", async () => {
    const permdock = await permdockFor(
      [{ tenant: "acme", roles: ["moderator"] }],
      [
        {
          tenant: "acme",
          name: "moderator",
          grants: [{ permission: "post.update" }],
        },
      ],
    );
    expect(permdock.can(permissions.post.update, otherPost)).toBe(true);
    const decision = permdock.decide(permissions.post.update, otherPost);
    expect(decision.outcome === "granted" && decision.matched.role).toBe(
      "moderator",
    );
  });

  it("keeps the declared deny of the role a grant comes from", async () => {
    const permdock = await permdockFor(
      [{ tenant: "acme", roles: ["refunds"] }],
      [
        {
          tenant: "acme",
          name: "refunds",
          grants: [{ permission: "invoice.refund" }],
        },
      ],
    );
    expect(permdock.can(permissions.invoice.refund, invoice)).toBe(true);
    expect(
      permdock.decide(permissions.invoice.refund, bigInvoice),
    ).toMatchObject({
      outcome: "denied",
      denials: [{ role: "refunds", reason: "deny" }],
    });
  });

  it("an own deny removes the permission, including from includes", async () => {
    const permdock = await permdockFor(
      [{ tenant: "acme", roles: ["clerk"] }],
      [
        {
          tenant: "acme",
          name: "clerk",
          includes: ["billing"],
          grants: [
            { permission: "invoice.refund" },
            { permission: "invoice.refund", effect: "deny" },
          ],
        },
      ],
    );
    expect(permdock.can(permissions.invoice.read, invoice)).toBe(true);
    expect(permdock.can(permissions.invoice.refund, invoice)).toBe(false);
  });

  it("never applies outside its tenant or to a declared name", async () => {
    const custom: CustomRole[] = [
      {
        tenant: "acme",
        name: "payer",
        grants: [{ permission: "invoice.pay" }],
      },
      { tenant: "globex", name: "payer", grants: [] },
      {
        tenant: "acme",
        name: "viewer",
        grants: [{ permission: "post.update" }],
      },
    ];
    const memberships: Membership[] = [
      { tenant: "acme", roles: ["payer", "viewer"] },
      { tenant: "globex", roles: ["payer"] },
    ];
    const acme = await permdockFor(memberships, custom);
    expect(acme.decide(permissions.invoice.pay, invoice).outcome).toBe(
      "approval-required",
    );
    expect(acme.can(permissions.invoice.pay, foreignInvoice)).toBe(false);
    expect(acme.can(permissions.post.update, otherPost)).toBe(false);
    const globex = await permdockFor(memberships, custom, "globex");
    expect(globex.decide(permissions.invoice.pay, foreignInvoice).outcome).toBe(
      "denied",
    );
  });

  it("scopes a team custom role to its team", async () => {
    const permdock = await permdockFor(
      [{ tenant: "acme", team: "t1", roles: ["reviewer"] }],
      [
        {
          tenant: "acme",
          team: "t1",
          name: "reviewer",
          grants: [{ permission: "board.read" }],
        },
      ],
    );
    expect(permdock.can(permissions.board.read, board)).toBe(true);
    expect(permdock.can(permissions.board.read, otherBoard)).toBe(false);
    expect(permdock.can(permissions.board.edit, board)).toBe(false);
  });
});

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe("the ceiling", () => {
  it("no custom role grants beyond the assignable declared roles", async () => {
    const random = lcg(42);
    const leaves = listPermissions(permissions);
    const keys = [...leaves.map((leaf) => leaf.key), "nope.read"];
    const names = ["owner", "admin", "billing", "editor", "viewer", "lead"];
    const rows = [invoice, bigInvoice, ownPost, otherPost, board, undefined];
    const pick = <T>(list: readonly T[]): T =>
      list[Math.floor(random() * list.length)]!;
    const everyAssignable = await permdockFor(
      [
        {
          tenant: "acme",
          roles: ["admin", "billing", "editor", "viewer", "steward"],
        },
        { tenant: "acme", team: "t1", roles: ["lead"] },
      ],
      [],
    );
    let reached = 0;
    for (let index = 0; index < 150; index += 1) {
      const team = random() < 0.2 ? "t1" : undefined;
      const custom: CustomRole = {
        tenant: "acme",
        ...(team === undefined ? {} : { team }),
        name: `c${index}`,
        includes: names.filter(() => random() < 0.3),
        grants: keys
          .filter(() => random() < 0.3)
          .map((permission) =>
            random() < 0.2
              ? { permission, effect: "deny" as const }
              : { permission },
          ),
      };
      const permdock = await permdockFor(
        [
          {
            tenant: "acme",
            ...(team === undefined ? {} : { team }),
            roles: [custom.name],
          },
        ],
        [custom],
      );
      for (let check = 0; check < 12; check += 1) {
        const leaf = pick(leaves);
        const row = leaf.kind === "collection" ? undefined : pick(rows);
        if (decideLeaf(permdock, leaf, row).outcome !== "denied") {
          reached += 1;
          expect(decideLeaf(everyAssignable, leaf, row).outcome).not.toBe(
            "denied",
          );
        }
      }
    }
    expect(reached).toBeGreaterThan(100);
  });
});

describe("assignable roles and permissions", () => {
  it("intersects the ceiling with what the subject holds", async () => {
    const permdock = await permdockFor(
      [{ tenant: "acme", roles: ["editor"] }],
      [],
    );
    expect(permdock.assignablePermissions().map((leaf) => leaf.key)).toEqual([
      "post.read",
      "post.update",
      "post.create",
    ]);
    expect(permdock.assignableRoles().map((leaf) => leaf.key)).toEqual([
      "editor",
    ]);
  });

  it("counts custom-role grants as held", async () => {
    const permdock = await permdockFor(
      [{ tenant: "acme", roles: ["reader"] }],
      [
        {
          tenant: "acme",
          name: "reader",
          grants: [{ permission: "post.read" }, { permission: "invoice.read" }],
        },
      ],
    );
    expect(permdock.assignableRoles().map((leaf) => leaf.key)).toEqual([
      "viewer",
      "reader",
    ]);
  });

  it("manageRoles on a role lifts the intersection", async () => {
    const permdock = await permdockFor(
      [{ tenant: "acme", roles: ["steward"] }],
      [],
    );
    expect(permdock.assignableRoles().map((leaf) => leaf.key)).toEqual([
      "admin",
      "billing",
      "editor",
      "viewer",
      "steward",
      "lead",
    ]);
    expect(permdock.assignablePermissions().map((leaf) => leaf.key)).toEqual([
      "invoice.read",
      "invoice.pay",
      "invoice.refund",
      "post.read",
      "post.update",
      "post.create",
      "member.invite",
    ]);
  });

  it("a granted manageRoles permission lifts the intersection", async () => {
    const permdock = await permdockFor(
      [{ tenant: "acme", roles: ["owner"] }],
      [],
    );
    expect(permdock.assignablePermissions()).toHaveLength(7);
    expect(permdock.assignableRoles().map((leaf) => leaf.key)).not.toContain(
      "owner",
    );
  });

  it("honours RoleSource.assignable per tenant", async () => {
    const source = {
      ...memoryRoleSource([]),
      assignable: async (tenant: string) =>
        tenant === "acme" ? ["viewer", "editor"] : [],
    };
    const permdock = await createPermDock(
      policy,
      subjectIn([
        { tenant: "acme", roles: ["steward"] },
        { tenant: "globex", roles: ["steward"] },
      ]),
      { tenant: "acme", customRoles: source },
    );
    expect(permdock.assignableRoles().map((leaf) => leaf.key)).toEqual([
      "editor",
      "viewer",
    ]);
    expect(permdock.assignablePermissions().map((leaf) => leaf.key)).toEqual([
      "invoice.read",
      "post.read",
      "post.update",
      "post.create",
    ]);
    expect(permdock.assignablePermissions({ tenant: "globex" })).toEqual([]);
    expect(permdock.assignableRoles({ tenant: "globex" })).toEqual([]);
  });

  it("a throwing RoleSource.assignable assigns nothing", async () => {
    const auth: unknown[] = [];
    const permdock = await createPermDock(
      policy,
      subjectIn([{ tenant: "acme", roles: ["steward"] }]),
      {
        tenant: "acme",
        customRoles: {
          rolesFor: () => [],
          assignable: () => {
            throw new Error("down");
          },
        },
      },
    );
    permdock.on("auth", (event) => {
      auth.push(event);
    });
    expect(permdock.assignableRoles()).toEqual([]);
    expect(permdock.assignablePermissions()).toEqual([]);
    expect(auth).toEqual([{ reason: "source-threw", source: "customRoles" }]);
  });

  it("is empty for anonymous subjects and without a tenant", async () => {
    const anonymous = await createPermDock(policy, null);
    expect(anonymous.assignableRoles()).toEqual([]);
    expect(anonymous.assignablePermissions()).toEqual([]);
  });
});

describe("assigning custom roles", () => {
  const postReader: CustomRole = {
    tenant: "acme",
    name: "post-reader",
    grants: [{ permission: "post.read" }],
  };
  const auditor: CustomRole = {
    tenant: "acme",
    name: "auditor",
    grants: [{ permission: "invoice.read" }, { permission: "post.read" }],
  };
  const boardEditor: CustomRole = {
    tenant: "acme",
    team: "t1",
    name: "board-editor",
    grants: [{ permission: "board.edit" }],
  };
  const elsewhere: CustomRole = {
    tenant: "globex",
    name: "globex-only",
    grants: [{ permission: "post.read" }],
  };
  const all = [postReader, auditor, boardEditor, elsewhere];
  const assign = (name: string, scope = "tenant", id = "acme") => ({
    kind: "assign" as const,
    role: name,
    scope,
    id,
    target: { id: "u2", roles: [] },
  });

  it("offers a custom role whose every permission the subject may hand out", async () => {
    const editor = await permdockFor(
      [{ tenant: "acme", roles: ["editor"] }],
      all,
    );
    expect(editor.assignableRoles().map((leaf) => leaf.key)).toEqual([
      "editor",
      "post-reader",
    ]);
    expect(editor.assignableRoles().at(-1)).toMatchObject({
      key: "post-reader",
      on: "tenant",
      assignable: true,
    });
    expect(editor.decideRoleChange(assign("post-reader"))).toMatchObject({
      outcome: "granted",
      role: null,
    });
    expect(editor.decideRoleChange(assign("auditor"))).toMatchObject({
      outcome: "denied",
      denials: [{ role: "auditor", reason: "not-assignable-by" }],
    });
  });

  it("lets a manageRoles holder assign any custom role of the tenant, without holder counts", async () => {
    const steward = await permdockFor(
      [{ tenant: "acme", roles: ["steward"] }],
      all,
    );
    expect(
      steward
        .assignableRoles()
        .map((leaf) => leaf.key)
        .filter((key) => !Object.hasOwn(roles, key)),
    ).toEqual(["auditor", "board-editor", "post-reader"]);
    for (const kind of ["assign", "revoke"] as const) {
      expect(
        steward.decideRoleChange({
          ...assign("auditor"),
          kind,
          target: { id: "u2", roles: kind === "revoke" ? ["auditor"] : [] },
        }).outcome,
      ).toBe("granted");
    }
  });

  it("holds a custom role at its own scope and pinned instance", async () => {
    const steward = await permdockFor(
      [{ tenant: "acme", roles: ["steward"] }],
      all,
    );
    const onTeam = (id: string) => ({
      ...assign("board-editor", "team", id),
      within: { tenant: "acme" },
    });
    expect(
      steward.decideRoleChange(onTeam("t1"), { trusted: true }).outcome,
    ).toBe("granted");
    expect(
      steward.decideRoleChange(onTeam("t2"), { trusted: true }),
    ).toMatchObject({ denials: [{ reason: "unknown-role" }] });
    expect(steward.decideRoleChange(assign("board-editor"))).toMatchObject({
      denials: [{ reason: "scope", detail: { expected: "team" } }],
    });
  });

  it("finds a custom role only in the instance's tenant", async () => {
    const steward = await permdockFor(
      [
        { tenant: "acme", roles: ["steward"] },
        { tenant: "globex", roles: ["steward"] },
      ],
      all,
    );
    expect(steward.decideRoleChange(assign("globex-only"))).toMatchObject({
      denials: [{ reason: "unknown-role" }],
    });
    expect(
      steward.decideRoleChange(assign("globex-only", "tenant", "globex"))
        .outcome,
    ).toBe("granted");
    expect(steward.decideRoleChange(assign("nobody"))).toMatchObject({
      denials: [{ reason: "unknown-role" }],
    });
  });

  it("follows RoleSource.assignable through the permissions it leaves", async () => {
    const steward = await createPermDock(
      policy,
      subjectIn([{ tenant: "acme", roles: ["steward"] }]),
      {
        tenant: "acme",
        customRoles: {
          ...memoryRoleSource(all),
          assignable: () => ["editor"],
        },
      },
    );
    expect(steward.assignableRoles().map((leaf) => leaf.key)).toEqual([
      "editor",
      "post-reader",
    ]);
  });

  it("never offers a custom role that allows nothing after the ceiling, and still revokes it", async () => {
    const voider: CustomRole = {
      tenant: "acme",
      name: "voider",
      grants: [{ permission: "invoice.void" }],
    };
    const blank: CustomRole = { tenant: "acme", name: "blank" };
    const denier: CustomRole = {
      tenant: "acme",
      name: "denier",
      grants: [{ permission: "post.read", effect: "deny" }],
    };
    const inert = [voider, blank, denier];
    for (const held of ["steward", "editor"]) {
      const actor = await permdockFor(
        [{ tenant: "acme", roles: [held] }],
        [...all, ...inert],
      );
      const offered = actor.assignableRoles().map((leaf) => leaf.key);
      for (const stored of inert) {
        expect(offered).not.toContain(stored.name);
        expect(actor.decideRoleChange(assign(stored.name))).toMatchObject({
          outcome: "denied",
          denials: [{ role: stored.name, reason: "not-assignable-by" }],
        });
        expect(
          actor.decideRoleChange({
            ...assign(stored.name),
            kind: "revoke",
            target: { id: "u2", roles: [stored.name] },
          }).outcome,
        ).toBe("granted");
      }
      expect(offered).toContain("post-reader");
    }
    const outsider = await permdockFor(
      [{ tenant: "acme", roles: ["lead"] }],
      inert,
    );
    expect(
      outsider.decideRoleChange({
        ...assign("voider"),
        kind: "revoke",
        target: { id: "u2", roles: ["voider"] },
      }),
    ).toMatchObject({ denials: [{ reason: "not-assignable-by" }] });
  });

  it("answers the same from a snapshot", async () => {
    const editor = await permdockFor(
      [{ tenant: "acme", roles: ["editor"] }],
      all,
    );
    const snapshot = editor.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error("expected JSON snapshot");
    }
    const client = fromSnapshot(snapshot);
    expect(client.assignableRoles().map((leaf) => leaf.key)).toEqual(
      editor.assignableRoles().map((leaf) => leaf.key),
    );
  });
});

describe("snapshot parity", () => {
  const fixtures: { readonly name: string; readonly custom: CustomRole }[] = [
    {
      name: "includes",
      custom: { tenant: "acme", name: "c", includes: ["editor"] },
    },
    {
      name: "own allow",
      custom: {
        tenant: "acme",
        name: "c",
        grants: [{ permission: "post.update" }],
      },
    },
    {
      name: "inherited deny",
      custom: {
        tenant: "acme",
        name: "c",
        grants: [{ permission: "invoice.refund" }],
      },
    },
    {
      name: "own deny",
      custom: {
        tenant: "acme",
        name: "c",
        includes: ["billing", "admin"],
        grants: [{ permission: "invoice.pay", effect: "deny" }],
      },
    },
    {
      name: "outside ceiling",
      custom: {
        tenant: "acme",
        name: "c",
        includes: ["owner"],
        grants: [{ permission: "invoice.void" }],
      },
    },
    {
      name: "team",
      custom: {
        tenant: "acme",
        team: "t1",
        name: "c",
        grants: [{ permission: "board.edit" }],
      },
    },
  ];
  const rows = [
    invoice,
    bigInvoice,
    foreignInvoice,
    ownPost,
    otherPost,
    board,
    otherBoard,
  ];

  for (const fixture of fixtures) {
    it(`decide and fromSnapshot agree: ${fixture.name}`, async () => {
      const membership: Membership =
        fixture.custom.team === undefined
          ? { tenant: "acme", roles: ["c"] }
          : { tenant: "acme", team: fixture.custom.team, roles: ["c"] };
      const server = await permdockFor([membership], [fixture.custom]);
      const snapshot = server.snapshot();
      if (snapshot instanceof Promise) {
        throw new Error("expected JSON snapshot");
      }
      const cached = snapshotFor(policy, subjectIn([membership]), {
        tenant: "acme",
        customRoles: [fixture.custom],
        now: snapshot.issuedAt,
      });
      expect(cached).toEqual(snapshot);
      const client = fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
      for (const leaf of listPermissions(permissions)) {
        for (const row of leaf.kind === "collection" ? [undefined] : rows) {
          expect(
            decideLeaf(client, leaf, row).outcome,
            `${leaf.key} ${JSON.stringify(row)}`,
          ).toBe(decideLeaf(server, leaf, row).outcome);
        }
      }
      expect(client.assignablePermissions().map((leaf) => leaf.key)).toEqual(
        server.assignablePermissions().map((leaf) => leaf.key),
      );
      expect(client.assignableRoles().map((leaf) => leaf.key)).toEqual(
        server.assignableRoles().map((leaf) => leaf.key),
      );
    });
  }

  it("include trims custom grants and assignable permissions", async () => {
    const server = await permdockFor(
      [{ tenant: "acme", roles: ["steward", "c"] }],
      [{ tenant: "acme", name: "c", grants: [{ permission: "invoice.read" }] }],
    );
    const snapshot = server.snapshot({ include: [permissions.post] });
    if (snapshot instanceof Promise) {
      throw new Error("expected JSON snapshot");
    }
    expect(
      snapshot.grants.every((grant) => grant.permission.startsWith("post.")),
    ).toBe(true);
    expect(
      snapshot.assignable?.[0]?.permissions.map((leaf) => leaf.key),
    ).toEqual(["post.read", "post.update", "post.create"]);
    const full = server.snapshot();
    if (full instanceof Promise) {
      throw new Error("expected JSON snapshot");
    }
    expect(full.grants).toContainEqual(
      expect.objectContaining({
        permission: "invoice.read",
        role: "c",
        membership: { scope: "tenant", id: "acme", roles: ["steward", "c"] },
      }),
    );
  });
});
