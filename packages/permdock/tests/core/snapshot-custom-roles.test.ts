import { describe, expect, it } from "vitest";

import { customRoleRecord } from "../../src/core/custom-role-record.ts";
import {
  compactSnapshot,
  expandSnapshot,
} from "../../src/core/snapshot-compact.ts";
import {
  expandedSnapshotFor,
  snapshotFor,
} from "../../src/core/snapshot-for.ts";
import { fromSnapshot, parseSnapshot } from "../../src/index.ts";
import { permissions, policy } from "../fixtures/saas.ts";

const INCLUDES = ["admin", "member", "viewer", "owner"] as const;

/** `count` custom roles of tenant acme, each including one declared role. */
function rolesOf(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    tenant: "acme",
    name: `custom-${String(index).padStart(2, "0")}`,
    includes: [INCLUDES[index % INCLUDES.length] ?? "viewer"],
  }));
}

function memberOf(roles: readonly { readonly name: string }[]) {
  return {
    id: "lee",
    memberships: [
      { scope: "tenant", id: "acme", roles: roles.map((role) => role.name) },
    ],
  };
}

describe("snapshotFor with custom roles", () => {
  it("names the roles and leaves their grants to the tenant record", () => {
    const roles = rolesOf(3);
    const lee = memberOf(roles);
    const snapshot = snapshotFor(policy, lee, {
      tenant: "acme",
      customRoles: roles,
    });
    expect(snapshot.custom?.held.map(([name]) => name)).toStrictEqual(
      roles.map((role) => role.name),
    );
    const record = customRoleRecord(policy, roles, "acme");
    expect(Object.keys(record.roles)).toStrictEqual(
      roles.map((role) => role.name),
    );
    const merged = fromSnapshot(parseSnapshot(JSON.stringify(snapshot)), {
      customRoles: [record],
    });
    expect(merged.can(permissions.member.invite)).toBe(true);
    expect(fromSnapshot(snapshot).can(permissions.member.invite)).toBe(false);
  });

  it("denies when the record is another tenant's or its digest is behind", () => {
    const roles = rolesOf(1);
    const snapshot = snapshotFor(policy, memberOf(roles), {
      tenant: "acme",
      customRoles: roles,
    });
    const other = customRoleRecord(
      policy,
      roles.map((role) => ({ ...role, tenant: "globex" })),
      "globex",
    );
    expect(
      fromSnapshot(snapshot, { customRoles: [other] }).can(
        permissions.member.invite,
      ),
    ).toBe(false);
    const edited = customRoleRecord(
      policy,
      roles.map((role) => ({ ...role, includes: ["viewer" as const] })),
      "acme",
    );
    expect(
      fromSnapshot(snapshot, { customRoles: [edited] }).can(
        permissions.member.invite,
      ),
    ).toBe(false);
  });

  it("is built once per list of roles and tenant", () => {
    const roles = rolesOf(2);
    expect(customRoleRecord(policy, roles, "acme")).toBe(
      customRoleRecord(policy, roles, "acme"),
    );
  });

  it("writes fewer bytes for a member with 1, 3 and 10 custom roles", () => {
    const bytes = (value: unknown): number =>
      new TextEncoder().encode(JSON.stringify(value)).length;
    const rows: string[] = [];
    for (const count of [1, 3, 10]) {
      const roles = rolesOf(count);
      const lee = memberOf(roles);
      const options = { tenant: "acme", customRoles: roles } as const;
      const inline = compactSnapshot(expandedSnapshotFor(policy, lee, options));
      const named = snapshotFor(policy, lee, options);
      const record = customRoleRecord(policy, roles, "acme");
      expect(
        expandSnapshot(named, { customRoles: [record] }).grants,
      ).toHaveLength(expandSnapshot(inline).grants.length);
      rows.push(
        `${String(count)} roles: inline ${String(bytes(inline))} B, named ${String(bytes(named))} B, record ${String(bytes(record))} B`,
      );
      expect(bytes(named)).toBeLessThan(bytes(inline));
    }
    process.stdout.write(`SNAPSHOT-CUSTOM-ROLES ${rows.join("; ")}\n`);
  });
});
