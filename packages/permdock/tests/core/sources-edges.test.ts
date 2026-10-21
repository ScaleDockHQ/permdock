import { describe, expect, it } from "vitest";

import { allow } from "../../src/core/grant-builders.ts";
import { getPermDockSync, getPermDock } from "../../src/core/permdock.ts";
import { getResource } from "../../src/core/permission-registry.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { membershipField } from "../../src/core/tenancy.ts";
import { memberPrincipal, policy, tree } from "../fixtures/org-tree.ts";
import { defined } from "../support/defined.ts";

describe("membership and role source edges", () => {
  it("resolves scoped memberships and delegation, and fails closed on throwing sources", async () => {
    const scoped = definePolicy(tree, {
      roles: [
        role("viewer", [allow(tree.post.read)], { on: "tenant" }),
        role("lead", [allow(tree.post.read)], { on: "team" }),
        role("owner", [allow(tree.post.read)], { on: tree.post }),
      ],
      scopes: {
        tenant: { key: "orgId" },
        team: { key: "teamId", within: "tenant" },
      },
      subject: () => ({
        id: "u1",
        memberships: [
          { tenant: "o1", roles: ["viewer"] },
          { tenant: "o1", team: "t1", roles: ["lead"] },
          { on: { resource: "org", id: "o1" }, roles: ["owner"] },
          {
            tenant: "o1",
            team: "t1",
            on: { resource: "post", id: "p1" },
            roles: ["invalid"],
          },
        ],
      }),
    });
    const permdock = getPermDockSync(scoped, { id: "u1" }, { tenant: "o1" });
    expect(
      permdock.can(tree.post.read, { id: "p1", orgId: "o1", teamId: "t1" }),
    ).toBe(true);
    expect(permdock.heldRoles({ tenant: "missing" })).toStrictEqual([]);
    expect(
      permdock
        .team("t9")
        .can(tree.post.read, { id: "p1", orgId: "o1", teamId: "t1" }),
    ).toBe(false);
    const delegated = getPermDockSync(policy, {
      principal: { id: "u1", roles: ["member"] },
      context: {},
      delegation: {
        scopes: [],
        authorizationDetails: [{ type: "post", actions: ["read"] }],
      },
    });
    expect(
      delegated.can(tree.post.read, { id: "p1", authorId: "u1", orgId: "o1" }),
    ).toBe(true);
    expect(delegated.can(tree.post.create)).toBe(false);
    const emptyScopes = getPermDockSync(policy, {
      principal: { id: "u1", roles: ["member"] },
      context: {},
      delegation: { scopes: [] },
    });
    const denied = emptyScopes.decide(tree.post.read, {
      id: "p1",
      authorId: "u1",
      orgId: "o1",
    });
    if (denied.outcome === "denied") {
      expect(denied.denials[0]?.reason).toBe("no-delegation");
    }
    expect(membershipField(undefined, "org", new Map())).toBeUndefined();
    const org = getResource(tree, "org");
    const post = getResource(tree, "post");
    const graph = new Map([
      ["org", defined(org)],
      ["post", defined(post)],
    ]);
    expect(membershipField(post, "org", graph)).toBe("orgId");
    expect(membershipField(post, "post", graph)).toBe("id");
    expect(membershipField(post, "team", graph)).toBeUndefined();
    const cycled = defined(post);
    const looping = new Map([
      ["post", { ...cycled, parent: { field: "orgId", resource: "post" } }],
    ]);
    expect(
      membershipField(looping.get("post"), "org", looping),
    ).toBeUndefined();

    const throwingSource = getPermDockSync(policy, memberPrincipal, {
      memberships: {
        membershipsFor(): never {
          throw new Error("boom");
        },
      },
    });
    const auth: unknown[] = [];
    throwingSource.on("auth", (event) => {
      auth.push(event);
    });
    expect(auth[0]).toMatchObject({ reason: "source-threw" });

    const asyncPermdock = await getPermDock(
      definePolicy(tree, {
        roles: [role("member", [allow(tree.post.read)])],
        subject: () => ({ id: "u1", roles: ["member"] }),
        context: async () => ({ async: true }),
      }),
      { id: "u1" },
      {
        memberships: {
          membershipsFor: async () => {
            throw new Error("async-fail");
          },
        },
        customRoles: {
          rolesFor: async () => {
            throw new Error("roles");
          },
        },
      },
    );
    expect(
      asyncPermdock.can(tree.post.read, {
        id: "p1",
        authorId: "u1",
        orgId: "o1",
      }),
    ).toBe(true);

    const throwingRoles = getPermDockSync(
      policy,
      {
        principal: {
          id: "u1",
          roles: ["member"],
          memberships: [{ tenant: "o1", roles: ["member"] }],
        },
        context: {},
      },
      {
        customRoles: {
          rolesFor(): never {
            throw new Error("roles");
          },
        },
      },
    );
    const roleAuth: unknown[] = [];
    throwingRoles.on("auth", (event) => {
      roleAuth.push(event);
    });
    expect(roleAuth.length).toBeGreaterThan(0);

    const anonymous = getPermDockSync(policy, null);
    expect(anonymous.tenant("o1").can(tree.post.read, { id: "p1" })).toBe(
      false,
    );
    expect(anonymous.heldRoles()).toStrictEqual([]);
    expect(anonymous.memberships()).toStrictEqual([]);
    expect(
      anonymous
        .simulate({ roles: ["member"] })
        .can(tree.post.read, { id: "p1", authorId: "u1" }),
    ).toBe(false);
  });

  it("resolves async custom roles and fails closed on a throwing subject or auth handler", async () => {
    const asyncRoles = await getPermDock(
      policy,
      {
        principal: {
          id: "u1",
          roles: ["member"],
          memberships: [{ tenant: "o1", roles: ["member"] }],
        },
        context: {},
      },
      {
        customRoles: {
          async rolesFor() {
            return [];
          },
        },
      },
    );
    expect(
      asyncRoles.can(tree.post.read, { id: "p1", authorId: "u1", orgId: "o1" }),
    ).toBe(true);
    const throwingSubject = getPermDockSync(
      definePolicy(tree, {
        roles: [role("member", [allow(tree.post.read)])],
        subject: () => {
          throw new Error("subject");
        },
      }),
      { id: "u1" },
    );
    expect(throwingSubject.can(tree.post.read, { id: "p1" })).toBe(false);
    const authErrors: unknown[] = [];
    const throwingAuth = getPermDockSync(policy, memberPrincipal, {
      memberships: {
        membershipsFor(): never {
          throw new Error("boom");
        },
      },
    });
    throwingAuth.on("error", (error) => {
      authErrors.push(error);
    });
    throwingAuth.on("auth", () => {
      throw new Error("auth-handler");
    });
    expect(authErrors.length).toBeGreaterThan(0);
  });
});
