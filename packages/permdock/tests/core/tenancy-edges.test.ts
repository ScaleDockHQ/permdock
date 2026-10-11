import { describe, expect, it } from "vitest";

import { getResource } from "../../src/core/permission-registry.ts";
import { defineScopes } from "../../src/core/scopes.ts";
import { matchScopedMembership, nowSeconds } from "../../src/core/tenancy.ts";
import { tree } from "../fixtures/org-tree.ts";

describe("matchScopedMembership edges", () => {
  it("matches a scoped membership only inside its scope, tenant, resource and expiry", () => {
    const now = nowSeconds(1_700_000_000);
    const tenantSubject = {
      principal: {
        id: "u1",
        tenant: "o1",
        memberships: [{ scope: "tenant", id: "o1", roles: ["viewer"] }],
      },
      context: {},
    };
    expect(
      matchScopedMembership(
        tenantSubject,
        "tenant",
        "viewer",
        { orgId: "o2" },
        defineScopes({ tenant: { key: "orgId" } }),
        undefined,
        new Map(),
        now,
      ).ok,
    ).toBe(false);
    expect(
      matchScopedMembership(
        { principal: null, context: {} },
        "tenant",
        "viewer",
        {},
        [],
        undefined,
        new Map(),
        now,
      ).ok,
    ).toBe(false);
    expect(
      matchScopedMembership(
        {
          principal: {
            id: "u1",
            tenant: "o1",
            memberships: [
              {
                scope: "team",
                id: "t1",
                within: { tenant: "o1" },
                roles: ["lead"],
              },
            ],
          },
          context: {},
        },
        "team",
        "lead",
        { teamId: "other" },
        defineScopes({
          tenant: { key: "orgId" },
          team: { key: "teamId", within: "tenant" },
        }),
        undefined,
        new Map(),
        now,
      ).ok,
    ).toBe(false);
    expect(
      matchScopedMembership(
        tenantSubject,
        { resource: "post" },
        "viewer",
        { id: "p1" },
        [],
        undefined,
        new Map(),
        now,
      ).ok,
    ).toBe(false);
    const expiredOnly = matchScopedMembership(
      {
        principal: {
          id: "u1",
          tenant: "gone",
          memberships: [
            { scope: "tenant", id: "gone", roles: ["viewer"], expiresAt: 1 },
          ],
        },
        context: {},
      },
      "tenant",
      "viewer",
      {},
      [],
      undefined,
      new Map(),
      now,
    );
    expect(expiredOnly.ok).toBe(false);
    const postNode = getResource(tree, "post");
    expect(
      matchScopedMembership(
        {
          principal: {
            id: "u1",
            memberships: [
              { on: { resource: "post", id: "p1" }, roles: ["owner"] },
            ],
          },
          context: {},
        },
        { resource: "post" },
        "owner",
        { id: "p1" },
        [],
        postNode,
        new Map(),
        now,
      ).ok,
    ).toBe(true);
    expect(
      matchScopedMembership(
        {
          principal: {
            id: "u1",
            memberships: [
              { on: { resource: "post", id: "p1" }, roles: ["owner"] },
            ],
          },
          context: {},
        },
        { resource: "post" },
        "owner",
        null,
        [],
        undefined,
        new Map(),
        now,
      ).ok,
    ).toBe(false);
    expect(
      matchScopedMembership(
        {
          principal: {
            id: "u1",
            memberships: [
              { on: { resource: "org", id: "o1" }, roles: ["owner"] },
            ],
          },
          context: {},
        },
        { resource: "post" },
        "owner",
        { id: "p1", orgId: "o9" },
        [],
        {
          name: "post",
          path: "post",
          id: "id",
          schema: undefined,
          parent: { field: "orgId", resource: "org" },
          links: {},
          relations: {},
          version: undefined,
          restricted: undefined,
          disclosure: "reveal",
          instanceActions: new Set(),
          collectionActions: new Set(),
        },
        new Map(),
        now,
      ).ok,
    ).toBe(false);
    expect(
      matchScopedMembership(
        {
          principal: {
            id: "u1",
            memberships: [
              {
                scope: "team",
                id: "t1",
                within: { tenant: "o1" },
                roles: ["lead"],
              },
            ],
          },
          context: {},
        },
        "team",
        "lead",
        { teamId: "t1" },
        defineScopes({
          tenant: { key: "orgId" },
          team: { key: "teamId", within: "tenant" },
        }),
        undefined,
        new Map(),
        1_700_000_000,
      ).ok,
    ).toBe(false);
    expect(
      matchScopedMembership(
        {
          principal: {
            id: "u1",
            tenant: "o1",
            memberships: [{ scope: "tenant", id: "o1", roles: ["viewer"] }],
          },
          context: {},
        },
        "team",
        "viewer",
        { teamId: "t1" },
        defineScopes({
          tenant: { key: "orgId" },
          team: { key: "teamId", within: "tenant" },
        }),
        undefined,
        new Map(),
        1_700_000_000,
      ).ok,
    ).toBe(false);
  });
});
