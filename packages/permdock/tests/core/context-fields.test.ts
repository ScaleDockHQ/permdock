import { describe, expect, it } from "vitest";
import { z } from "zod";

import { context } from "../../src/conditions/refs.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, deny, role } from "../../src/core/policy.ts";
import { unsigned } from "../fixtures/snapshots.ts";

const Post = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  secret: z.string(),
  teamId: z.string(),
});

const permissions = definePermissions({
  post: resource(Post, {
    id: "id",
    actions: ["read", "update"],
    collection: ["list"],
  }),
});

const row = {
  id: "p1",
  title: "Hello",
  body: "World",
  secret: "hidden",
  teamId: "t1",
};

describe("async context", () => {
  it("loads relations once and evaluates portable where against them", async () => {
    const policy = definePolicy(permissions, {
      roles: [
        role("member", [
          allow(permissions.post.read, {
            where: { teamId: { in: context["teamIds"] } },
          }),
        ]),
      ],
      subject: () => ({ id: "u1", roles: ["member"] }),
      context: async () => ({ teamIds: ["t1"] }),
    });
    const created = createPermDock(policy, { id: "u1" });
    expect(created).toBeInstanceOf(Promise);
    const permdock = await created;
    expect(permdock.subject.context).toEqual({ teamIds: ["t1"] });
    expect(permdock.can(permissions.post.read, row)).toBe(true);
    expect(
      permdock.can(permissions.post.read, { ...row, teamId: "other" }),
    ).toBe(false);
  });

  it("fails closed when context throws or rejects", async () => {
    const throwing = definePolicy(permissions, {
      roles: [
        role("member", [
          allow(permissions.post.read, {
            where: { teamId: { in: context["teamIds"] } },
          }),
        ]),
      ],
      subject: () => ({ id: "u1", roles: ["member"] }),
      context: () => {
        throw new Error("sync-fail");
      },
    });
    const syncPermdock = await createPermDock(throwing, { id: "u1" });
    const syncAuth: unknown[] = [];
    syncPermdock.on("auth", (event) => {
      syncAuth.push(event);
    });
    expect(syncAuth[0]).toMatchObject({
      reason: "source-threw",
      source: "context",
    });
    expect(syncPermdock.subject.context).toEqual({});
    expect(syncPermdock.can(permissions.post.read, row)).toBe(false);

    const rejecting = definePolicy(permissions, {
      roles: [
        role("member", [
          allow(permissions.post.read, {
            where: { teamId: { in: context["teamIds"] } },
          }),
        ]),
      ],
      subject: () => ({ id: "u1", roles: ["member"] }),
      context: async () => {
        throw new Error("async-fail");
      },
    });
    const asyncPermdock = await createPermDock(rejecting, { id: "u1" });
    expect(asyncPermdock.subject.context).toEqual({});
    expect(asyncPermdock.can(permissions.post.read, row)).toBe(false);
  });

  it("treats a non-object context result as empty", async () => {
    const policy = definePolicy(permissions, {
      roles: [role("member", [allow(permissions.post.read)])],
      subject: () => ({ id: "u1", roles: ["member"] }),
      // SAFETY: a deliberately non-object context result, which the instance treats as empty.
      context: () => null as unknown as Record<string, unknown>,
    });
    const permdock = await createPermDock(policy, { id: "u1" });
    expect(permdock.subject.context).toEqual({});
    // SAFETY: a deliberately null row, which pick() answers with an empty object.
    expect(
      permdock.pick(permissions.post.read, null as unknown as typeof row),
    ).toEqual({});
  });

  it("strips forbidden keys from loaded context", async () => {
    const policy = definePolicy(permissions, {
      roles: [role("member", [allow(permissions.post.read)])],
      subject: () => ({ id: "u1", roles: ["member"] }),
      context: () => ({
        teamIds: ["t1"],
        constructor: "nope",
        __proto__: { polluted: true },
      }),
    });
    const permdock = await createPermDock(policy, { id: "u1" });
    expect(permdock.subject.context).toEqual({ teamIds: ["t1"] });
    expect(permdock.subject.context).not.toHaveProperty("constructor");
  });
});

describe("schema-aware field-level grants", () => {
  it("restricts pick and field checks to declared fields", async () => {
    const policy = definePolicy(permissions, {
      roles: [
        role("member", [
          allow(permissions.post.read, { fields: ["title", "body"] }),
        ]),
      ],
      subject: () => ({ id: "u1", roles: ["member"] }),
    });
    const permdock = await createPermDock(policy, { id: "u1" });
    expect(permdock.can(permissions.post.read, row)).toBe(true);
    expect(permdock.can(permissions.post.read, row, { field: "title" })).toBe(
      true,
    );
    expect(permdock.can(permissions.post.read, row, { field: "secret" })).toBe(
      false,
    );
    expect(permdock.pick(permissions.post.read, row)).toEqual({
      title: "Hello",
      body: "World",
    });
  });

  it("lets a field deny override an unrestricted allow", async () => {
    const policy = definePolicy(permissions, {
      roles: [
        role("member", [
          allow(permissions.post.read),
          deny(permissions.post.read, { fields: ["secret"] }),
        ]),
      ],
      subject: () => ({ id: "u1", roles: ["member"] }),
    });
    const permdock = await createPermDock(policy, { id: "u1" });
    expect(permdock.can(permissions.post.read, row)).toBe(true);
    expect(permdock.can(permissions.post.read, row, { field: "secret" })).toBe(
      false,
    );
    expect(permdock.pick(permissions.post.read, row)).toEqual({
      id: "p1",
      title: "Hello",
      body: "World",
      teamId: "t1",
    });
  });

  it("fails closed on an empty fields list", async () => {
    const policy = definePolicy(permissions, {
      roles: [role("member", [allow(permissions.post.read, { fields: [] })])],
      subject: () => ({ id: "u1", roles: ["member"] }),
    });
    const permdock = await createPermDock(policy, { id: "u1" });
    expect(permdock.can(permissions.post.read, row)).toBe(false);
    expect(permdock.pick(permissions.post.read, row)).toEqual({});
  });

  it("ships fields on the snapshot and evaluates them fromSnapshot", async () => {
    const policy = definePolicy(permissions, {
      roles: [
        role("member", [allow(permissions.post.read, { fields: ["title"] })]),
      ],
      subject: () => ({ id: "u1", roles: ["member"] }),
    });
    const server = await createPermDock(policy, { id: "u1" });
    const snapshot = unsigned(server.snapshot());
    expect(snapshot.grants[0]?.fields).toEqual(["title"]);
    const client = fromSnapshot(snapshot);
    expect(client.can(permissions.post.read, row)).toBe(true);
    expect(client.pick(permissions.post.read, row)).toEqual({ title: "Hello" });
    expect(client.can(permissions.post.read, row, { field: "body" })).toBe(
      false,
    );
  });
});
