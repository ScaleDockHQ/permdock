import { describe, expect, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";
import type { Principal } from "../../src/core/subject.ts";

import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { authenticated, plan } from "../../src/core/grantee.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";

async function both(
  policy: Parameters<typeof createPermDock<Principal>>[0],
  user: Principal,
): Promise<readonly [PermDock, PermDock]> {
  const server = await createPermDock(policy, user);
  const client = fromSnapshot(parseSnapshot(JSON.stringify(server.snapshot())));
  return [server, client];
}

describe("snapshot parity", () => {
  const permissions = definePermissions({
    doc: resource({ id: "uuid", actions: ["read"] }),
    note: resource({ actions: ["read"] }),
  });

  it("reads a resource's own id field for a membership on one row", async () => {
    const policy = definePolicy(permissions, {
      subject: (user: Principal) => user,
      roles: [
        role("watcher", [allow(permissions.doc.read)], { on: permissions.doc }),
      ],
    });
    const user: Principal = {
      id: "u1",
      memberships: [{ on: { resource: "doc", id: "d1" }, roles: ["watcher"] }],
    };
    const [server, client] = await both(policy, user);
    expect(parseSnapshot(JSON.stringify(server.snapshot())).ids).toEqual({
      doc: "uuid",
    });
    for (const permdock of [server, client]) {
      expect(permdock.can(permissions.doc.read, { uuid: "d1" })).toBe(true);
      expect(permdock.can(permissions.doc.read, { uuid: "d2" })).toBe(false);
      expect(permdock.can(permissions.doc.read, { id: "d1" })).toBe(false);
    }
  });

  it("leaves ids out when every resource reads id", async () => {
    const policy = definePolicy(permissions, {
      subject: (user: Principal) => user,
      roles: [role("reader", [allow(permissions.note.read)])],
    });
    const [server] = await both(policy, { id: "u1", roles: ["reader"] });
    expect(parseSnapshot(JSON.stringify(server.snapshot()))).not.toHaveProperty(
      "ids",
    );
  });

  it("counts a seat held in a named scope the same way", async () => {
    const policy = definePolicy(permissions, {
      scopes: { org: { key: "org_id" } },
      subject: (user: Principal) => user,
      grants: [allow(permissions.note.read, { to: plan("pro") })],
    });
    const user: Principal = {
      id: "u1",
      tenant: "o1",
      memberships: [
        { scope: "org", id: "o1", roles: [], entitlements: ["pro"] },
      ],
    };
    const [server, client] = await both(policy, user);
    expect(server.can(permissions.note.read, {})).toBe(true);
    expect(client.can(permissions.note.read, {})).toBe(true);
  });

  it("answers false from can when reading the row throws", async () => {
    const policy = definePolicy(permissions, {
      subject: (user: Principal) => user,
      grants: [
        allow(permissions.note.read, {
          to: authenticated(),
          where: { owner: { eq: "u1" } },
        }),
      ],
    });
    const row = {
      get owner(): string {
        throw new Error("getter");
      },
    };
    for (const permdock of await both(policy, { id: "u1" })) {
      expect(permdock.can(permissions.note.read, row)).toBe(false);
    }
  });
});
