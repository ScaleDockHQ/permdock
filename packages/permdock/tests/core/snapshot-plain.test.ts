import { describe, expect, it } from "vitest";

import type { Membership } from "../../src/index.ts";

import { plan } from "../../src/core/grantee.ts";
import {
  allow,
  createPermDock,
  definePermissions,
  definePlans,
  definePolicy,
  defineRoles,
  deny,
  inherit,
  localSnapshotManifest,
  memoryRelations,
  relation,
  resource,
  role,
  snapshotFor,
} from "../../src/index.ts";

const permissions = definePermissions({
  drive: resource({
    actions: ["read", "manage"],
    collection: ["create"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      viewer: { edge: "drive_shares", object: "drive_id" },
    },
  }),
  file: resource({
    actions: ["read", "delete"],
    links: { drive: { field: "driveId", resource: "drive" } },
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  invoice: resource({
    actions: ["read", "pay"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const { drive, file, invoice } = permissions;

const roles = defineRoles({
  owner: {
    on: "tenant",
    meta: { title: "Owner", audience: "staff", manageRoles: true },
  },
  member: { on: "tenant", meta: { tags: ["staff"] } },
  blocked: { on: "tenant" },
  support: { meta: { audience: "platform" } },
});

const plans = definePlans({ pro: { meta: { title: "Pro" } } });

type User = {
  readonly id: string;
  readonly roles?: readonly string[];
  readonly memberships?: readonly Membership[];
};

const policy = definePolicy(
  { permissions, roles, plans },
  {
    scopes: { tenant: { key: "orgId" } },
    roles: [
      role(roles.owner, [
        allow(drive.manage),
        allow(drive.create),
        allow(invoice.pay, { approval: "human" }),
      ]),
      role(roles.member, [
        allow(file.read, { where: { orgId: "acme" } }),
        allow(invoice.read, { to: plan(plans.pro) }),
      ]),
      role(roles.blocked, [deny(file.delete)]),
      role(roles.support, [allow(invoice.read)]),
    ],
    grants: [
      allow(drive.read, { to: relation(drive, "viewer"), requires: file.read }),
      allow(file.delete, { to: inherit(drive.manage, { through: ["drive"] }) }),
    ],
    subject: (user: User) => ({
      id: user.id,
      roles: user.roles ?? [],
      memberships: user.memberships ?? [],
    }),
  },
);

const relations = memoryRelations(permissions, {
  tables: { drive_shares: [{ drive_id: "d1", user_id: "ana" }] },
});

const customRoles = {
  rolesFor: (tenant: string) =>
    tenant === "acme"
      ? [{ name: "reader", tenant, grants: [{ permission: "file.read" }] }]
      : [],
};

const ana: User = {
  id: "ana",
  roles: ["support"],
  memberships: [
    { tenant: "acme", roles: ["owner", "member", "reader"] },
    { tenant: "globex", roles: ["member", "blocked"] },
  ],
};

function nonPlain(value: unknown, path: string, out: string[]): string[] {
  if (typeof value === "function" || typeof value === "symbol") {
    out.push(`${path}: ${typeof value}`);
    return out;
  }
  if (value === null || typeof value !== "object") {
    return out;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  const expected = Array.isArray(value) ? Array.prototype : Object.prototype;
  if (prototype !== expected && prototype !== null) {
    out.push(`${path}: prototype`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (typeof key === "symbol") {
      out.push(`${path}: symbol key`);
    } else if (Array.isArray(value) && key === "length") {
      continue;
    } else if (descriptor?.enumerable !== true) {
      out.push(`${path}.${key}: not enumerable`);
    } else if (descriptor.get !== undefined || descriptor.set !== undefined) {
      out.push(`${path}.${key}: accessor`);
    } else {
      nonPlain(descriptor.value, `${path}.${key}`, out);
    }
  }
  return out;
}

describe("snapshots are plain data", () => {
  it("carries only plain, JSON and structured-clone safe values in every shape", async () => {
    const permdock = await createPermDock(policy, ana, {
      relations,
      customRoles,
    });
    const shapes = {
      own: permdock.snapshot(),
      all: permdock.snapshot({ tenants: "all" }),
      tenant: permdock.tenant("acme").snapshot(),
      other: permdock.tenant("globex").snapshot({ include: [file] }),
      offline: snapshotFor(policy, ana, { tenants: "all" }),
      manifest: localSnapshotManifest(policy),
    };
    expect(shapes.all.assignable?.length).toBeGreaterThan(0);
    expect(shapes.all.vocabulary?.roles?.["owner"]?.kind).toBe("role");
    expect(shapes.all.vocabulary?.plans?.["pro"]?.kind).toBe("plan");
    expect(
      shapes.all.grants.some((grant) => grant.approval !== undefined),
    ).toBe(true);
    for (const [name, snapshot] of Object.entries(shapes)) {
      expect(nonPlain(snapshot, name, [])).toEqual([]);
      expect(JSON.parse(JSON.stringify(snapshot))).toStrictEqual(snapshot);
      expect(structuredClone(snapshot)).toStrictEqual(snapshot);
    }
  });
});
