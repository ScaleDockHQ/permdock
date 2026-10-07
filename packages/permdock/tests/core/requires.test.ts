import { describe, expect, it } from "vitest";

import type { Membership } from "../../src/index.ts";

import { compileGrants } from "../../src/cli/rls-compile.ts";
import { requiresSql } from "../../src/cli/rls-permission-keys.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  deny,
  memoryRelations,
  relation,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  drive: resource({
    actions: ["read"],
    collection: ["create"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      viewer: { edge: "drive_shares", object: "drive_id" },
    },
  }),
  file: resource({
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const { drive, file } = permissions;

type User = {
  readonly id: string;
  readonly roles?: readonly string[];
  readonly memberships?: readonly Membership[];
};

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("member", [allow(file.read)], { on: "tenant", assignable: true }),
    role("guest", [allow(drive.create)], { on: "tenant", assignable: true }),
    role("blocked", [deny(file.read)], { on: "tenant" }),
    role("auditor", [allow(file.read)]),
    role("ownFiles", [allow(file.read, { where: { orgId: "acme" } })], {
      on: "tenant",
    }),
  ],
  grants: [
    allow(drive.read, {
      to: relation(drive, "viewer"),
      requires: file.read,
    }),
  ],
  subject: (user: User) => ({
    id: user.id,
    roles: user.roles ?? [],
    memberships: user.memberships ?? [],
  }),
});

const drives = [
  { id: "d-acme", orgId: "acme" },
  { id: "d-globex", orgId: "globex" },
];

const relations = memoryRelations(permissions, {
  tables: {
    drive_shares: ["ana", "gus", "bob", "cora", "eve", "aud", "own"].flatMap(
      (user_id) => [
        { drive_id: "d-acme", user_id },
        { drive_id: "d-globex", user_id },
      ],
    ),
  },
});

const customRoles = {
  rolesFor: (tenant: string) =>
    tenant === "acme"
      ? [{ name: "reader", tenant, grants: [{ permission: "file.read" }] }]
      : [],
};

async function readable(user: User): Promise<readonly string[]> {
  const permdock = await createPermDock(policy, user, {
    relations,
    customRoles,
  });
  await permdock.loadRelations(drive.read, drives);
  return drives
    .filter((row) => permdock.can(drive.read, row))
    .map((row) => row.id);
}

const member = (tenant: string, ...roles: string[]): Membership => ({
  tenant,
  roles,
});

describe("requires: a grant that counts only where a permission is also held", () => {
  it("counts a share only in the organization where the subject also holds the permission", async () => {
    expect(
      await readable({ id: "ana", memberships: [member("acme", "member")] }),
    ).toEqual(["d-acme"]);
    expect(
      await readable({ id: "eve", memberships: [member("globex", "member")] }),
    ).toEqual(["d-globex"]);
    expect(
      await readable({ id: "gus", memberships: [member("acme", "guest")] }),
    ).toEqual([]);
    expect(
      await readable({ id: "nobody", memberships: [member("acme", "member")] }),
    ).toEqual([]);
  });

  it("subtracts a deny of the required permission at that organization", async () => {
    expect(
      await readable({
        id: "bob",
        memberships: [member("acme", "member", "blocked")],
      }),
    ).toEqual([]);
    expect(
      await readable({
        id: "bob",
        memberships: [
          member("acme", "member", "blocked"),
          member("globex", "member"),
        ],
      }),
    ).toEqual(["d-globex"]);
  });

  it("counts a custom role that grants the required permission", async () => {
    expect(
      await readable({ id: "cora", memberships: [member("acme", "reader")] }),
    ).toEqual(["d-acme"]);
    expect(
      await readable({ id: "cora", memberships: [member("globex", "reader")] }),
    ).toEqual([]);
  });

  it("passes every row when the subject holds the permission globally", async () => {
    expect(await readable({ id: "aud", roles: ["auditor"] })).toEqual([
      "d-acme",
      "d-globex",
    ]);
  });

  it("ignores a role grant of the required permission that carries a row condition", async () => {
    expect(
      await readable({ id: "own", memberships: [member("acme", "ownFiles")] }),
    ).toEqual([]);
  });

  it("puts the requirement into where() and the snapshot", async () => {
    const ana = await createPermDock(
      policy,
      { id: "ana", memberships: [member("acme", "member")] },
      { relations },
    );
    expect(JSON.stringify(ana.where(drive.read).condition)).toContain(
      '{"op":"in","field":"orgId","value":["acme"]}',
    );
    const client = fromSnapshot(parseSnapshot(JSON.stringify(ana.snapshot())));
    expect(client.can(drive.read, drives[0])).toBe(false);
    const aud = await createPermDock(
      policy,
      { id: "aud", roles: ["auditor"] },
      { relations },
    );
    expect(JSON.stringify(aud.where(drive.read).condition)).not.toContain(
      '"in"',
    );
  });

  it("rejects requires on a deny, on a collection action, as a non-permission and when undeclared", () => {
    expect(() => deny(drive.read, { requires: file.read })).toThrow(
      /allowed on an allow only/u,
    );
    expect(() => allow(drive.create, { requires: file.read })).toThrow(
      /needs an instance action/u,
    );
    // SAFETY: an untyped requires, as a JavaScript caller could pass it.
    expect(() => allow(drive.read, { requires: "file.read" as never })).toThrow(
      /must be a permission leaf/u,
    );
    const other = definePermissions({
      secret: resource({ actions: ["read"] }),
    });
    expect(() =>
      definePolicy(permissions, {
        grants: [
          allow(drive.read, {
            to: relation(drive, "viewer"),
            requires: other.secret.read,
          }),
        ],
        subject: () => null,
      }),
    ).toThrow(/requires 'secret.read', which the policy does not declare/u);
  });
});

describe("requires in generated RLS", () => {
  it("adds the permission-key helpers to the grant's access and marks its key conditioned", () => {
    const ctx = {
      dialect: "supabase" as const,
      scopes: scopeList(policy.scopes),
      tenantClaim: "tenant_id",
      gucPrefix: "app",
    };
    const compiled = compileGrants(policy, ctx, undefined, [], false);
    const branch = compiled.branches.find(
      (item) => item.permissionKey === "drive.read",
    );
    expect(branch?.access).toContain(
      `(select "permdock".permdock_has_permission('file.read')) or "orgId" in (select "permdock".permitted_tenant_ids_by_permission('file.read'))`,
    );
    expect(requiresSql(ctx, "file.read", undefined)).toBe(
      `((select "permdock".permdock_has_permission('file.read')))`,
    );
  });
});
