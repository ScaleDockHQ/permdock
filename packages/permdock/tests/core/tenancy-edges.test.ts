import { describe, expect, it } from "vitest";

import { getResource } from "../../src/core/permission-registry.ts";
import {
  defineScopes,
  normalizeMembership,
  resolveScope,
} from "../../src/core/scopes.ts";
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

describe(defineScopes, () => {
  it("rejects a non-object and a team that is not second", () => {
    // SAFETY: the runtime guard is what this test exercises.
    expect(() => defineScopes(null as never)).toThrow("must be an object");
    expect(() => defineScopes({ team: { key: "id" } })).toThrow(
      "declared second",
    );
    expect(resolveScope(defineScopes(undefined), 1)).toBeUndefined();
  });

  it("drops a membership whose extra fields are not the canonical shape", () => {
    const scopes = defineScopes({ tenant: { key: "orgId" } });
    const row = { scope: "tenant", id: "o1", roles: ["member"] };
    expect(
      normalizeMembership({ ...row, keep: "nope" }, scopes),
    ).toBeUndefined();
    expect(
      normalizeMembership({ ...row, tenant: "o1" }, scopes),
    ).toBeUndefined();
    expect(
      normalizeMembership({ roles: ["member"], on: null }, scopes),
    ).toBeUndefined();
    expect(normalizeMembership({ ...row, within: [] }, scopes)).toBeUndefined();
    const within: Record<string, string> = {};
    const forbidden = "constructor";
    within[forbidden] = "o1";
    expect(normalizeMembership({ ...row, within }, scopes)).toBeUndefined();
    expect(
      normalizeMembership(
        { roles: ["member"], scope: "nope", id: "o1" },
        scopes,
      ),
    ).toBeUndefined();
  });
});
