import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Principal } from "../../src/index.ts";

import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import {
  allow,
  anyone,
  getPermDockSync,
  definePermissions,
  definePolicy,
  deny,
  resource,
  role,
} from "../../src/index.ts";
import { reasonOf } from "../fixtures/decisions.ts";

const Doc = z.object({ id: z.string(), locked: z.boolean() });
const permissions = definePermissions({
  doc: resource(Doc, { id: "id", actions: ["read", "update"] }),
});
const open = { id: "d1", locked: false };
const locked = { id: "d2", locked: true };
const subject = (user: { id: string; roles: string[] }) => user;

describe("invariant 2: deny overrides allow", () => {
  it("applies a deny whose grantee kind this build does not know to everyone", async () => {
    const policy = definePolicy(permissions, {
      grants: [
        allow(permissions.doc.read, { to: anyone() }),
        // SAFETY: a grantee kind from a newer document, which no typed call can build.
        deny(permissions.doc.read, { to: { kind: "wizard" } as never }),
      ],
      subject,
    });
    const permdock = getPermDockSync(policy, { id: "u1", roles: [] });
    expect(permdock.can(permissions.doc.read, open)).toBe(false);
  });

  it("denies whatever the grant order inside one role", async () => {
    for (const grants of [
      [
        allow(permissions.doc.update),
        deny(permissions.doc.update, { where: { locked: true } }),
      ],
      [
        deny(permissions.doc.update, { where: { locked: true } }),
        allow(permissions.doc.update),
      ],
    ]) {
      const policy = definePolicy(permissions, {
        roles: [role("editor", grants)],
        subject,
      });
      const permdock = getPermDockSync(policy, {
        id: "u1",
        roles: ["editor"],
      });
      expect(permdock.can(permissions.doc.update, locked)).toBe(false);
      expect(permdock.can(permissions.doc.update, open)).toBe(true);
    }
  });

  it("lets a deny in one role override an allow in another", async () => {
    const policy = definePolicy(permissions, {
      roles: [
        role("owner", [allow(permissions.doc.update)]),
        role("suspended", [deny(permissions.doc.update)]),
      ],
      subject,
    });
    for (const roles of [
      ["owner", "suspended"],
      ["suspended", "owner"],
    ]) {
      const permdock = getPermDockSync(policy, { id: "u1", roles });
      const decision = permdock.decide(permissions.doc.update, open);
      expect(decision.outcome).toBe("denied");
      expect(reasonOf(decision)).toBe("deny");
    }
  });

  it("names the deny that won over the allows in explain", async () => {
    const policy = definePolicy(permissions, {
      roles: [
        role("owner", [allow(permissions.doc.update)]),
        role("editor", [allow(permissions.doc.update)]),
        role("suspended", [
          deny(permissions.doc.update, { name: "suspension" }),
        ]),
      ],
      subject,
    });
    const permdock = getPermDockSync(policy, {
      id: "u1",
      roles: ["owner", "editor", "suspended"],
    });
    const explained = permdock.explain(permissions.doc.update, open);
    expect(explained.outcome).toBe("denied");
    expect(explained.trace.denies.map((grant) => grant.name)).toEqual([
      "suspension",
    ]);
    expect(explained.trace.allows.map((grant) => grant.role)).toEqual([
      "owner",
      "editor",
    ]);
  });

  it("lets a deny override an allow that needs approval", async () => {
    const policy = definePolicy(permissions, {
      roles: [
        role("editor", [
          allow(permissions.doc.update, { approval: "human" }),
          deny(permissions.doc.update, { where: { locked: true } }),
        ]),
      ],
      subject,
    });
    const permdock = getPermDockSync(policy, {
      id: "u1",
      roles: ["editor"],
    });
    expect(permdock.decide(permissions.doc.update, locked).outcome).toBe(
      "denied",
    );
    expect(permdock.decide(permissions.doc.update, open).outcome).toBe(
      "approval-required",
    );
  });

  it("keeps the deny in the server-side where filter", async () => {
    const policy = definePolicy(permissions, {
      roles: [
        role("editor", [
          allow(permissions.doc.read),
          deny(permissions.doc.read, { where: { locked: true } }),
        ]),
      ],
      subject,
    });
    const permdock = getPermDockSync(policy, {
      id: "u1",
      roles: ["editor"],
    });
    const where = permdock.where(permissions.doc.read);
    expect(where.condition).toEqual({
      op: "not",
      condition: { op: "eq", field: "locked", value: true },
    });
  });

  describe("an update pair", () => {
    const pair = (from: typeof open, to: typeof open) => ({
      current: from,
      next: { ...to, id: from.id },
    });
    const pairs = [
      ["locked to unlocked", pair(locked, open), false],
      ["unlocked to locked", pair(open, locked), false],
      ["locked to locked", pair(locked, locked), false],
      ["unlocked to unlocked", pair(open, open), true],
    ] as const;

    async function editor() {
      const policy = definePolicy(permissions, {
        roles: [
          role("editor", [
            allow(permissions.doc.update),
            deny(permissions.doc.update, { where: { locked: true } }),
          ]),
        ],
        subject,
      });
      return getPermDockSync(policy, { id: "u1", roles: ["editor"] });
    }

    it.each(pairs)(
      "is denied when either row matches the deny (%s)",
      async (_name, rows, allowed) => {
        const permdock = await editor();
        expect(permdock.can(permissions.doc.update, rows)).toBe(allowed);
        const client = fromSnapshot(permdock.snapshot());
        expect(client.can(permissions.doc.update, rows)).toBe(allowed);
      },
    );

    it("still needs both rows to match an allow", async () => {
      const policy = definePolicy(permissions, {
        roles: [
          role("editor", [
            allow(permissions.doc.update, { where: { locked: false } }),
          ]),
        ],
        subject,
      });
      const permdock = getPermDockSync(policy, {
        id: "u1",
        roles: ["editor"],
      });
      const client = fromSnapshot(permdock.snapshot());
      for (const [_name, rows, allowed] of pairs) {
        expect(permdock.can(permissions.doc.update, rows)).toBe(allowed);
        expect(client.can(permissions.doc.update, rows)).toBe(allowed);
      }
    });

    it("applies a scoped deny when the row moves into or out of its scope", async () => {
      const Item = z.object({ id: z.string(), org: z.string() });
      const items = definePermissions({
        item: resource(Item, {
          id: "id",
          actions: ["update"],
          relations: { org: { field: "org", memberOf: "org" } },
        }),
      });
      const policy = definePolicy(items, {
        scopes: { org: { key: "org" } },
        roles: [
          role("editor", [allow(items.item.update)]),
          role("frozen", [deny(items.item.update)], { on: "org" }),
        ],
        subject: (user: Principal) => user,
      });
      const permdock = getPermDockSync(policy, {
        id: "u1",
        roles: ["editor"],
        tenant: "A",
        memberships: [{ scope: "org", id: "A", roles: ["frozen"] }],
      });
      const inA = { id: "i1", org: "A" };
      const inB = { id: "i1", org: "B" };
      expect(permdock.can(items.item.update, { current: inB, next: inB })).toBe(
        true,
      );
      expect(permdock.can(items.item.update, { current: inA, next: inB })).toBe(
        false,
      );
      expect(permdock.can(items.item.update, { current: inB, next: inA })).toBe(
        false,
      );
    });
  });
});
