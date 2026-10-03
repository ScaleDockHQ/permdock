import { describe, expect, it } from "vitest";

import type { SnapshotGrant } from "../../src/core/interfaces.ts";
import type { Scope } from "../../src/core/scopes.ts";
import type { WhereScope } from "../../src/core/where-scope.ts";

import { definePermissions, resource } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { whereFromGrants } from "../../src/core/where-scope.ts";

const scopes: readonly Scope[] = [
  { name: "tenant", key: "orgId" },
  { name: "team", key: "teamId", within: "tenant" },
];

const permissions = definePermissions({
  folder: resource({ id: "id", actions: ["read"] }),
  doc: resource({
    id: "id",
    actions: ["read"],
    parent: { field: "folderId", resource: "folder" },
  }),
  note: resource({ id: "id", actions: ["read"] }),
});

const { resources } = definePolicy(permissions, {
  scopes: {
    tenant: { key: "orgId" },
    team: { key: "teamId", within: "tenant" },
  },
  subject: () => null,
});

const NONE = { op: "or", conditions: [] };
const NOW = 1_800_000_000;

function scope(overrides: Partial<WhereScope> = {}): WhereScope {
  return {
    resource: "doc",
    scopes,
    partitioned: () => true,
    tenant: "o1",
    team: undefined,
    now: NOW,
    subject: { principal: { id: "u1" }, context: {} },
    ...overrides,
  };
}

function grant(overrides: Partial<SnapshotGrant>): SnapshotGrant {
  return {
    permission: "doc.read",
    effect: "allow",
    role: "member",
    to: { kind: "role", role: "member", scope: "global" },
    ...overrides,
  };
}

const tenantMember = { scope: "tenant", id: "o1", roles: ["member"] };

describe("whereFromGrants scope filters", () => {
  it.each([
    {
      name: "an expired membership reaches no row",
      grants: [
        grant({
          scope: "tenant",
          membership: { ...tenantMember, expiresAt: NOW - 1 },
        }),
      ],
      expected: NONE,
    },
    {
      name: "a membership in another named scope reaches no row",
      grants: [grant({ scope: "team", membership: tenantMember })],
      expected: NONE,
    },
    {
      name: "a resource grant without an on membership reaches no row",
      grants: [grant({ scope: { resource: "doc" }, membership: tenantMember })],
      expected: NONE,
    },
    {
      name: "a team membership with no team id matches nothing in the team",
      grants: [
        grant({
          scope: "team",
          membership: { scope: "team", within: { tenant: "o1" }, roles: [] },
        }),
      ],
      expected: {
        op: "and",
        conditions: [{ op: "eq", field: "orgId", value: "o1" }, NONE],
      },
    },
  ])("$name", ({ grants, expected }) => {
    expect(whereFromGrants(grants, scope()).condition).toEqual(expected);
  });

  it("adds no filter for a scope that does not partition the resource", () => {
    expect(
      whereFromGrants(
        [grant({ scope: "tenant", membership: tenantMember })],
        scope({ partitioned: () => false }),
      ).condition,
    ).toEqual({ op: "eq", field: "_", value: true });
  });

  it("matches only the row id without the resource graph", () => {
    const on = (resourceName: string) =>
      grant({
        scope: { resource: resourceName },
        membership: { on: { resource: resourceName, id: "x1" }, roles: [] },
      });
    expect({
      own: whereFromGrants([on("doc")], scope()).condition,
      other: whereFromGrants([on("folder")], scope()).condition,
    }).toEqual({ own: { op: "eq", field: "id", value: "x1" }, other: NONE });
  });

  it("walks the parent field with the resource graph and refuses an unrelated resource", () => {
    const viaFolder = grant({
      scope: { resource: "folder" },
      membership: { on: { resource: "folder", id: "f1" }, roles: [] },
    });
    const viaNote = grant({
      scope: { resource: "folder" },
      membership: { on: { resource: "note", id: "n1" }, roles: [] },
    });
    expect({
      folder: whereFromGrants([viaFolder], scope({ resources })).condition,
      note: whereFromGrants([viaNote], scope({ resources })).condition,
      unrelated: whereFromGrants(
        [viaFolder],
        scope({ resources, resource: "note" }),
      ).condition,
    }).toEqual({
      folder: { op: "eq", field: "folderId", value: "f1" },
      note: NONE,
      unrelated: NONE,
    });
  });
});

describe("whereFromGrants denies", () => {
  const globalAllow = grant({});

  it("empties the result for an unconditional global deny", () => {
    const result = whereFromGrants(
      [globalAllow, grant({ effect: "deny" })],
      scope(),
    );
    expect(result).toEqual({ condition: NONE, partial: false });
  });

  it("ignores a deny whose membership reaches no row", () => {
    expect(
      whereFromGrants(
        [
          globalAllow,
          grant({
            effect: "deny",
            scope: "tenant",
            membership: { ...tenantMember, id: "o2" },
          }),
        ],
        scope(),
      ).condition,
    ).toEqual({ op: "eq", field: "_", value: true });
  });

  it("subtracts a scoped deny from a global allow", () => {
    expect(
      whereFromGrants(
        [
          globalAllow,
          grant({ effect: "deny", scope: "tenant", membership: tenantMember }),
        ],
        scope(),
      ).condition,
    ).toEqual({
      op: "not",
      condition: { op: "eq", field: "orgId", value: "o1" },
    });
  });

  it("drops a resource allow its resource deny covers and subtracts one it does not", () => {
    const onDoc = (id: string, effect: "allow" | "deny") =>
      grant({
        effect,
        scope: { resource: "doc" },
        membership: { on: { resource: "doc", id }, roles: [] },
      });
    expect({
      covered: whereFromGrants(
        [onDoc("d1", "allow"), onDoc("d1", "deny")],
        scope(),
      ).condition,
      other: whereFromGrants(
        [onDoc("d2", "allow"), onDoc("d1", "deny")],
        scope(),
      ).condition,
    }).toEqual({
      covered: NONE,
      other: {
        op: "and",
        conditions: [
          { op: "eq", field: "id", value: "d2" },
          { op: "not", condition: { op: "eq", field: "id", value: "d1" } },
        ],
      },
    });
  });

  it("subtracts a named deny from a resource allow it cannot prove it covers", () => {
    expect(
      whereFromGrants(
        [
          grant({
            scope: { resource: "doc" },
            membership: { on: { resource: "doc", id: "d1" }, roles: [] },
          }),
          grant({ effect: "deny", scope: "tenant", membership: tenantMember }),
        ],
        scope(),
      ).condition,
    ).toEqual({
      op: "and",
      conditions: [
        { op: "eq", field: "id", value: "d1" },
        { op: "not", condition: { op: "eq", field: "orgId", value: "o1" } },
      ],
    });
  });
});
