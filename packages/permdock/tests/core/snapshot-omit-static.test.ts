import { describe, expect, it } from "vitest";

import type { Decision } from "../../src/core/decision.ts";
import type { PermDock } from "../../src/core/permdock.ts";
import type { Permission } from "../../src/core/permission-types.ts";
import type { Policy } from "../../src/core/policy-types.ts";
import type { ClientBundle, Snapshot } from "../../src/core/snapshot-types.ts";
import type { Principal } from "../../src/core/subject.ts";

import { clientBundle } from "../../src/core/client-bundle.ts";
import { allow, deny } from "../../src/core/grant-builders.ts";
import { fromSnapshot, getPermDockSync } from "../../src/core/permdock.ts";
import { listPermissions } from "../../src/core/permission-registry.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { expandSnapshot } from "../../src/core/snapshot-compact.ts";
import { snapshotFor } from "../../src/core/snapshot-for.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import {
  policy as commerce,
  commerceUser,
} from "../fixtures/centrakit-shape.ts";
import {
  adminOf,
  mixed,
  policy as large,
  rowsFor,
} from "../fixtures/large-policy.ts";
import { tree } from "../fixtures/org-tree.ts";
import {
  alice,
  bob,
  otherProject,
  ownProject,
  policy as saas,
} from "../fixtures/saas.ts";

/**
 * The fixtures' policies take different user types; the tests pass each its
 * own.
 */
function erase(policy: object): Policy {
  // SAFETY: a policy of any user type is the erased Policy the snapshot code reads.
  return policy as unknown as Policy;
}

type Case = {
  readonly name: string;
  readonly policy: Policy;
  readonly user: object;
  readonly tenant: string;
  readonly rows: readonly object[];
  readonly tenants?: "all";
};

const cases: readonly Case[] = [
  {
    name: "large admin",
    policy: erase(large),
    user: adminOf("o0"),
    tenant: "o0",
    rows: rowsFor("o0", "u-o0"),
  },
  {
    name: "large mixed, all tenants",
    policy: erase(large),
    user: mixed(),
    tenant: "o0",
    rows: rowsFor("o0", "u-mixed"),
    tenants: "all",
  },
  {
    name: "commerce user",
    policy: erase(commerce),
    user: commerceUser(),
    tenant: "org0",
    rows: rowsFor("org0", "u-commerce"),
    tenants: "all",
  },
  {
    name: "saas admin",
    policy: erase(saas),
    user: alice,
    tenant: "acme",
    rows: [ownProject, otherProject],
    tenants: "all",
  },
  {
    name: "saas member",
    policy: erase(saas),
    user: bob,
    tenant: "acme",
    rows: [ownProject, otherProject],
  },
];

function decide(
  client: PermDock,
  leaf: Permission,
  row: object | undefined,
): Decision {
  // SAFETY: decide's overloads type the row per leaf; these leaves are checked with plain rows.
  const run = client.decide as (
    permission: Permission,
    data?: unknown,
  ) => Decision;
  return run(leaf, row);
}

function decisions(
  client: PermDock,
  policy: Policy,
  rows: readonly object[],
): string[] {
  return listPermissions(policy.permissions).flatMap((leaf) =>
    [undefined, ...rows].map((row) => {
      const result = decide(client, leaf, row);
      const reasons =
        result.outcome === "denied"
          ? result.denials.map((denial) => denial.reason).toSorted()
          : [];
      return `${leaf.key}|${String(row === undefined ? undefined : Reflect.get(row, "id"))}|${result.outcome}|${reasons.join(",")}`;
    }),
  );
}

function wireOf(
  policy: Policy,
  user: object,
  tenant: string,
  omitStatic: boolean,
  tenants?: "all" | readonly string[],
): Snapshot {
  const snapshot = getPermDockSync(policy, user, { tenant }).snapshot({
    omitAssignable: true,
    ...(tenants === undefined ? {} : { tenants }),
    ...(omitStatic ? { omitStatic: true } : {}),
  });
  if (snapshot instanceof Promise) {
    throw new TypeError("snapshot must be synchronous");
  }
  return snapshot;
}

describe("snapshot omitStatic", () => {
  describe.each(cases)("$name", (item) => {
    const full = wireOf(
      item.policy,
      item.user,
      item.tenant,
      false,
      item.tenants,
    );
    const lean = wireOf(
      item.policy,
      item.user,
      item.tenant,
      true,
      item.tenants,
    );
    const bundle = clientBundle(item.policy);

    it("decides every permission as the full snapshot does", () => {
      const expected = decisions(
        fromSnapshot(full, { tenant: item.tenant }),
        item.policy,
        item.rows,
      );
      const actual = decisions(
        fromSnapshot(lean, { tenant: item.tenant, bundle }),
        item.policy,
        item.rows,
      );
      expect(actual).toStrictEqual(expected);
    });

    it("survives a JSON round trip", () => {
      const parsed = parseSnapshot(JSON.stringify(lean));
      expect(expandSnapshot(parsed, { bundle }).grants).toHaveLength(
        expandSnapshot(full).grants.length,
      );
    });

    it("carries fewer bytes", () => {
      expect(JSON.stringify(lean).length).toBeLessThan(
        JSON.stringify(full).length,
      );
      expect(lean.static?.held.length).toBeGreaterThan(0);
    });

    it("grants less without the bundle", () => {
      const granted = (client: PermDock): number =>
        decisions(client, item.policy, item.rows).filter((line) =>
          line.includes("|granted|"),
        ).length;
      expect(granted(fromSnapshot(lean, { tenant: item.tenant }))).toBeLessThan(
        granted(fromSnapshot(lean, { tenant: item.tenant, bundle })),
      );
    });
  });

  it("builds the same references through snapshotFor and the instance", () => {
    const viaFor = snapshotFor(erase(saas), bob, {
      tenant: "acme",
      omitAssignable: true,
      omitStatic: true,
    });
    const viaInstance = wireOf(erase(saas), bob, "acme", true);
    expect(viaFor.static).toStrictEqual(viaInstance.static);
  });

  it("builds one bundle per policy, pinned by digests", () => {
    const policy = erase(saas);
    expect(clientBundle(policy)).toBe(clientBundle(policy));
    for (const entry of Object.values(clientBundle(policy).roles)) {
      expect(entry.digest).toMatch(/^sha-256:/u);
    }
  });

  describe("fail closed", () => {
    const policy = erase(saas);
    const lean = wireOf(policy, alice, "acme", true, "all");
    const bundle = clientBundle(policy);
    const create = saas.permissions.project.create;

    it("denies with a stale digest", () => {
      const stale: ClientBundle = {
        ...bundle,
        roles: Object.fromEntries(
          Object.entries(bundle.roles).map(([name, entry]) => [
            name,
            { ...entry, digest: "sha-256:stale" },
          ]),
        ),
      };
      expect(fromSnapshot(lean, { tenant: "acme", bundle }).can(create)).toBe(
        true,
      );
      expect(
        fromSnapshot(lean, { tenant: "acme", bundle: stale }).can(create),
      ).toBe(false);
    });

    it("rejects a membership index out of range", () => {
      const broken = structuredClone(lean);
      const held = broken.static?.held.map(([name]) => [name, 99]);
      expect(() =>
        parseSnapshot({ ...broken, static: { ...broken.static, held } }),
      ).toThrow(/static/u);
    });

    it("rejects a malformed digest", () => {
      const digests = { admin: "md5:abc" };
      expect(() =>
        parseSnapshot({ ...lean, static: { ...lean.static, digests } }),
      ).toThrow(/static/u);
    });
  });

  describe("inline fallbacks", () => {
    const claimed = erase(
      definePolicy(tree, {
        scopes: { tenant: { key: "orgId" } },
        subject: (user: Principal | null) => user,
        roles: [
          role(
            "editor",
            [
              allow(tree.post.read),
              allow(tree.post.update, {
                where: { ownerId: { ref: "principal.claims.team" } },
              }),
            ],
            { on: "tenant" },
          ),
          role("secret", [allow(tree.post.read), deny(tree.post.update)], {
            on: "tenant",
            meta: { clientBundle: false },
          }),
        ],
      }),
    );
    const user = {
      id: "u1",
      claims: { team: "t1" },
      memberships: [{ scope: "tenant", id: "o1", roles: ["editor", "secret"] }],
    };
    const rows = [
      { id: "p1", orgId: "o1", ownerId: "t1" },
      { id: "p2", orgId: "o1", ownerId: "t2" },
    ];

    it("still decides a role whose grants bind a claim", () => {
      const lean = wireOf(claimed, user, "o1", true);
      const full = wireOf(claimed, user, "o1", false);
      const bundle = clientBundle(claimed);
      expect(
        decisions(fromSnapshot(lean, { tenant: "o1", bundle }), claimed, rows),
      ).toStrictEqual(
        decisions(fromSnapshot(full, { tenant: "o1" }), claimed, rows),
      );
    });

    it("leaves a role with meta.clientBundle false inline", () => {
      expect(Object.keys(clientBundle(claimed).roles)).not.toContain("secret");
      const lean = wireOf(claimed, user, "o1", true);
      expect(lean.static?.held.map(([name]) => name) ?? []).not.toContain(
        "secret",
      );
      expect(
        expandSnapshot(lean).grants.some((grant) => grant.role === "secret"),
      ).toBe(true);
    });
  });
});

describe("default snapshot tenants", () => {
  const policy = erase(large);
  const user = mixed();

  it("ships only the active tenant's grants", () => {
    const only = wireOf(policy, user, "o0", false);
    const all = wireOf(policy, user, "o0", false, "all");
    const scoped = expandSnapshot(only).grants;
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((grant) => grant.membership?.id === "o0")).toBe(true);
    expect(expandSnapshot(all).grants.length).toBeGreaterThan(scoped.length);
    expect(only.tenants).toStrictEqual(["o0"]);
  });

  it("ships the named tenants and no others", () => {
    const some = wireOf(policy, user, "o0", false, ["o0", "o3"]);
    const ids = new Set(
      expandSnapshot(some).grants.map((grant) => grant.membership?.id),
    );
    expect(
      [...ids].toSorted((a, b) => String(a).localeCompare(String(b))),
    ).toStrictEqual(["o0", "o3"]);
  });
});
