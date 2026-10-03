import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ConvexError, createPermDock } from "../../src/convex/index.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";

const Post = z.object({
  id: z.string(),
  authorId: z.string(),
});

const permissions = definePermissions({
  post: resource(Post, {
    id: "id",
    actions: ["read", "delete"],
    collection: ["list"],
  }),
});

const policy = definePolicy(permissions, {
  roles: [
    role("member", [
      allow(permissions.post.read),
      allow(permissions.post.list),
    ]),
  ],
  subject: (user: { id: string; roles: readonly string[] } | null) =>
    user === null ? null : { id: user.id, roles: user.roles },
});

describe("permdock/convex", () => {
  it("attaches a request-scoped instance and never reads function args", async () => {
    const seen: unknown[] = [];
    const { withPermDock } = createPermDock(policy, {
      subject: (ctx) => {
        seen.push(ctx);
        return { id: "user-1", roles: ["member"] };
      },
    });
    const remove = withPermDock(async (ctx, args: { id: string }) => {
      expect(
        ctx.permdock.can(permissions.post.read, {
          id: args.id,
          authorId: "user-1",
        }),
      ).toBe(true);
      return args.id;
    });
    const ctx = {
      auth: { getUserIdentity: async () => ({ subject: "user-1" }) },
    };
    await expect(remove(ctx, { id: "p1" })).resolves.toBe("p1");
    expect(seen).toEqual([ctx]);
  });

  it("maps assert denials to a ConvexError with Problem Details", async () => {
    const { withPermDock } = createPermDock(policy, {
      subject: () => ({ id: "user-1", roles: ["member"] }),
    });
    const remove = withPermDock((ctx) => {
      ctx.permdock.assert(permissions.post.delete, {
        id: "p1",
        authorId: "user-1",
      });
    });
    await expect(remove({}, {})).rejects.toMatchObject({
      name: "ConvexError",
      data: {
        type: "https://permdock.dev/problems/denied",
        title: "Permission denied",
        status: 403,
        permission: "post.delete",
      },
    });
    await expect(remove({}, {})).rejects.toBeInstanceOf(ConvexError);
  });

  it("filter and can never throw for an anonymous caller", async () => {
    const { withPermDock } = createPermDock(policy, {
      subject: () => null,
    });
    const list = withPermDock((ctx) => {
      const rows = [
        { id: "p1", authorId: "user-1" },
        { id: "p2", authorId: "user-2" },
      ];
      return {
        can: ctx.permdock.can(permissions.post.read, rows[0]),
        filtered: ctx.permdock.filter(permissions.post.read, rows),
      };
    });
    await expect(list({}, {})).resolves.toEqual({
      can: false,
      filtered: [],
    });
  });

  it("returns a snapshot from snapshotQuery without failing on denial", async () => {
    const { snapshotQuery } = createPermDock(policy, {
      subject: () => ({ id: "user-1", roles: ["member"] }),
    });
    // SAFETY: a Convex query registration exposes the handler passed to query() as .handler.
    const query = snapshotQuery() as {
      handler: (
        ctx: object,
        args: Record<string, never>,
      ) => Promise<{
        readonly grants: readonly unknown[];
      }>;
    };
    const snapshot = await query.handler({}, {});
    expect(snapshot.grants.length).toBeGreaterThan(0);
  });

  it("fails closed to anonymous when the subject resolver throws", async () => {
    const { withPermDock } = createPermDock(policy, {
      subject: () => {
        throw new Error("identity unavailable");
      },
    });
    const list = withPermDock((ctx) => ctx.permdock.can(permissions.post.list));
    await expect(list({}, {})).resolves.toBe(false);
  });
});
