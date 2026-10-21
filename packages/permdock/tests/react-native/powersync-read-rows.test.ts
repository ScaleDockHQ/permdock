import { describe, expect, it } from "vitest";

import type { LocalSnapshotRows } from "../../src/index.ts";

import { parseLocalSnapshotManifest } from "../../src/core/parse-local-manifest.ts";
import { readRows, rowTables } from "../../src/react-native/powersync-rows.ts";

const rows: LocalSnapshotRows = {
  memberships: [
    {
      table: "seats",
      user: { column: "user_id" },
      scope: { column: "kind" },
      id: "org_id",
      roles: [
        { column: "tier", map: { business: "owner", free: null } },
        { column: "role" },
      ],
      via: { column: "via" },
      disabledAt: "disabled_at",
    },
    {
      table: "guests",
      user: {
        column: "account_id",
        through: { table: "accounts", id: "id", column: "user_id" },
      },
      scope: { value: "project" },
      id: "project_id",
      roles: { value: ["guest"] },
      via: { value: "invite" },
    },
  ],
  roles: {
    table: "global_roles",
    user: "user_id",
    roles: [
      {
        column: "role_id",
        through: { table: "roles", id: "id", column: "key" },
      },
    ],
  },
  customRoles: { permissions: "crp", includes: "cri" },
};

const tables = {
  seats: [
    { user_id: "u1", kind: "org", org_id: 7, tier: "business", role: "" },
    { user_id: "u1", kind: "org", org_id: 7, tier: "free", role: "editor" },
    { user_id: "u1", kind: "org", org_id: 8, tier: "unknown", role: null },
    { user_id: "u1", kind: "org", org_id: 9, tier: "business", via: "sso" },
    { user_id: "u1", kind: null, org_id: 10, role: "editor" },
    {
      user_id: "u1",
      kind: "org",
      org_id: 11,
      role: "editor",
      disabled_at: "2026-01-01",
    },
    { user_id: "u2", kind: "org", org_id: 7, role: "owner" },
    "not a row",
  ],
  accounts: [{ id: 1, user_id: "u1" }],
  guests: [
    { account_id: 1, project_id: "p1" },
    { account_id: 2, project_id: "p2" },
  ],
  roles: [{ id: 5n, key: "support" }],
  global_roles: [
    { user_id: "u1", role_id: 5n },
    { user_id: "u1", role_id: 6 },
    { user_id: "u2", role_id: 5n },
  ],
  crp: [
    {
      tenant_id: "t1",
      scope: "org",
      scope_id: "7",
      role: "dispatch",
      permission: "job.read",
      effect: "allow",
      level: "team",
    },
    {
      tenant_id: "t1",
      scope: "org",
      scope_id: "7",
      role: "dispatch",
      permission: "job.update",
      effect: "deny",
    },
    { scope: "global", role: "auditor", permission: "job.read" },
    { scope: "org", role: "shared-viewer", permission: "job.read" },
    { scope: "org", permission: "job.read" },
    { scope: "org", role: "nameless-permission" },
  ],
  cri: [
    {
      tenant_id: "t1",
      scope: "org",
      scope_id: "7",
      role: "dispatch",
      include_role: "viewer",
    },
    { scope: "org", role: "shared-viewer", include_role: "" },
    { role: "no-scope", include_role: "viewer" },
  ],
};

describe(readRows, () => {
  it("lists every table the rows name, including through tables", () => {
    expect(rowTables(rows)).toStrictEqual([
      "seats",
      "guests",
      "accounts",
      "global_roles",
      "roles",
      "crp",
      "cri",
    ]);
    expect(rowTables({ memberships: [] })).toStrictEqual([]);
  });

  it("reads memberships through maps, fixed values, via and through tables", () => {
    const data = readRows(rows, tables, { id: "u1" });
    expect(data.principal?.memberships).toStrictEqual([
      { scope: "org", id: "7", roles: ["editor", "owner"] },
      { scope: "org", id: "9", roles: ["owner"], via: "sso" },
      { scope: "project", id: "p1", roles: ["guest"], via: "invite" },
    ]);
    expect(data.principal?.roles).toStrictEqual(["support"]);
    expect(data.principal).not.toHaveProperty("tenant");
    expect(data.principal).not.toHaveProperty("attributes");
  });

  it("reads tenant, shared and global custom roles with their includes", () => {
    const data = readRows(rows, tables, {
      id: "u1",
      tenant: "t1",
      attributes: { claims: { team_ids: ["blue"] } },
    });
    expect(data.principal).toMatchObject({
      tenant: "t1",
      attributes: { claims: { team_ids: ["blue"] } },
    });
    expect(data.customRoles).toStrictEqual([
      {
        name: "dispatch",
        tenant: "t1",
        scope: "org",
        id: "7",
        grants: [
          { permission: "job.read", effect: "allow", level: "team" },
          { permission: "job.update", effect: "deny" },
        ],
        includes: ["viewer"],
      },
      {
        name: "auditor",
        scope: "global",
        grants: [{ permission: "job.read", effect: "allow" }],
        includes: [],
      },
      {
        name: "shared-viewer",
        shared: true,
        scope: "org",
        grants: [{ permission: "job.read", effect: "allow" }],
        includes: [],
      },
    ]);
  });

  it("reads nothing from tables the device has not synced", () => {
    const data = readRows(rows, {}, { id: "u1" });
    expect(data.principal?.memberships).toStrictEqual([]);
    expect(data.principal?.roles).toStrictEqual([]);
    expect(data.customRoles).toStrictEqual([]);
    expect(
      readRows({ memberships: [] }, {}, { id: "u1" }).customRoles,
    ).toBeUndefined();
  });
});

describe("parseLocalSnapshotManifest rows", () => {
  const manifest = (value: unknown): Record<string, unknown> => ({
    v: 1,
    roles: [],
    grants: [],
    custom: {},
    rows: value,
  });
  const membership = {
    table: "seats",
    user: { column: "user_id" },
    scope: { value: "org" },
    id: "org_id",
    roles: [{ column: "role" }],
  };

  it("accepts every rows shape readRows reads", () => {
    expect(parseLocalSnapshotManifest(manifest(rows))).toBe(true);
    expect(parseLocalSnapshotManifest({ ...manifest(rows), rank: [] })).toBe(
      true,
    );
  });

  it.each([
    ["rows that are not an object", "rows"],
    ["a membership that is not an object", { memberships: ["seats"] }],
    [
      "a column with both through and map",
      {
        memberships: [
          {
            ...membership,
            roles: [
              {
                column: "role",
                through: { table: "roles", id: "id", column: "key" },
                map: { a: "b" },
              },
            ],
          },
        ],
      },
    ],
    [
      "a map to a number",
      {
        memberships: [
          { ...membership, roles: [{ column: "role", map: { a: 1 } }] },
        ],
      },
    ],
    [
      "a fixed role value that is not a list",
      { memberships: [{ ...membership, roles: { value: "owner" } }] },
    ],
    [
      "a via with neither column nor value",
      { memberships: [{ ...membership, via: {} }] },
    ],
    ["an empty expiresAt", { memberships: [{ ...membership, expiresAt: "" }] }],
    [
      "a numeric disabledAt",
      { memberships: [{ ...membership, disabledAt: 1 }] },
    ],
  ])("rejects %s", (_name, value) => {
    expect(parseLocalSnapshotManifest(manifest(value))).toBe(false);
  });

  it("rejects a rank that is not a list of strings", () => {
    expect(
      parseLocalSnapshotManifest({
        ...manifest({ memberships: [] }),
        rank: [1],
      }),
    ).toBe(false);
  });
});
