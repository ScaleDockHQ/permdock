import { describe, expect, it } from "vitest";

import type { ScanResult } from "../../src/cli/types.ts";
import type {
  Membership,
  RoleChangeTarget,
  RoleRules,
} from "../../src/index.ts";

import { buildCatalog } from "../../src/cli/catalog-doc.ts";
import {
  allow,
  checkRoleChange,
  decideRoleChange,
  definePermissions,
  definePolicy,
  getPermDockSync,
  resource,
  role,
} from "../../src/index.ts";

const scan: ScanResult = {
  roots: [],
  definitionFiles: {},
  usages: {},
  unknown: [],
  dynamic: [],
  roleNames: [],
  planNames: [],
  allowKeys: [],
  snapshots: [],
  unparsed: [],
};

const permissions = definePermissions({
  doc: resource({
    actions: ["read"],
    relations: { org: { field: "org_id", memberOf: "org" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { org: { key: "org_id" } },
  subject: (user: { id: string; memberships: readonly Membership[] }) => ({
    ...user,
    roles: [],
  }),
  roles: [
    role("owner", [allow(permissions.doc.read)], {
      on: "org",
      min: 1,
      max: 2,
      assigns: ["admin", "member", "guest"],
    }),
    role("admin", [allow(permissions.doc.read)], {
      on: "org",
      assigns: ["member", "guest"],
      for: ["staff"],
    }),
    role("member", [allow(permissions.doc.read)], {
      on: "org",
      for: ["staff"],
      exclusiveWith: ["guest"],
    }),
    role("guest", [allow(permissions.doc.read)], {
      on: "org",
      transferOnly: true,
    }),
  ],
});

const catalogRoles: readonly RoleRules[] =
  buildCatalog(policy.permissions, scan, "2026-10-01T00:00:00Z", policy)
    .roles ?? [];

const admin = getPermDockSync(policy, {
  id: "u_admin",
  memberships: [{ scope: "org", id: "o_1", roles: ["admin"], via: "staff" }],
});

const cases: readonly {
  readonly role: string;
  readonly kind: "assign" | "revoke";
  readonly target: Pick<RoleChangeTarget, "via" | "roles">;
  readonly holders?: number;
}[] = [
  { role: "member", kind: "assign", target: { via: "staff", roles: [] } },
  { role: "member", kind: "assign", target: { via: "contact", roles: [] } },
  {
    role: "member",
    kind: "assign",
    target: { via: "staff", roles: ["guest"] },
  },
  {
    role: "guest",
    kind: "assign",
    target: { via: "staff", roles: ["member"] },
  },
  { role: "guest", kind: "assign", target: { roles: [] }, holders: 0 },
  { role: "guest", kind: "assign", target: { roles: [] }, holders: 3 },
  { role: "guest", kind: "assign", target: { roles: [] } },
  { role: "member", kind: "revoke", target: { roles: ["member"] } },
];

function catalogRole(name: string): RoleRules {
  const found = catalogRoles.find((entry) => entry.key === name);
  if (found === undefined) {
    throw new Error(`missing ${name}`);
  }
  return found;
}

describe(checkRoleChange, () => {
  it("agrees with decideRoleChange from the catalog roles alone", () => {
    for (const entry of cases) {
      const decided = decideRoleChange(admin, {
        kind: entry.kind,
        role: entry.role,
        scope: "org",
        id: "o_1",
        target: { id: "u_target", ...entry.target },
        ...(entry.holders === undefined ? {} : { holders: entry.holders }),
      });
      const checked = checkRoleChange(catalogRole(entry.role), {
        change: { kind: entry.kind, target: entry.target },
        ...(entry.holders === undefined ? {} : { holders: entry.holders }),
        roles: catalogRoles,
        actorRoles: ["admin"],
      });
      expect(
        checked.ok ? [] : checked.denials.map((denial) => denial.reason),
      ).toStrictEqual(
        decided.outcome === "granted"
          ? []
          : decided.denials.map((denial) => denial.reason),
      );
      if (checked.ok && decided.outcome === "granted") {
        expect(checked.by).toBe(decided.role);
      }
    }
  });

  it("checks holder counts and assigns without an actor role list", () => {
    expect(
      checkRoleChange(catalogRole("owner"), {
        change: { kind: "revoke", target: { roles: ["owner"] } },
        holders: 1,
      }),
    ).toStrictEqual({
      ok: false,
      denials: [
        {
          role: "owner",
          reason: "last-holder",
          detail: { role: "owner", min: 1, holders: 1 },
        },
      ],
    });
    expect(
      checkRoleChange(catalogRole("admin"), {
        change: { kind: "assign", target: { via: "staff" } },
        roles: catalogRoles,
        actorRoles: ["member"],
      }),
    ).toMatchObject({
      ok: false,
      denials: [{ reason: "not-assignable-by", detail: { held: ["member"] } }],
    });
  });

  it("denies a malformed change", () => {
    expect(
      checkRoleChange(catalogRole("member"), {
        // SAFETY: the input comes from an untyped caller in this case.
        change: { kind: "promote" as "assign", target: {} },
      }),
    ).toStrictEqual({
      ok: false,
      denials: [{ role: "member", reason: "validation" }],
    });
  });
});
