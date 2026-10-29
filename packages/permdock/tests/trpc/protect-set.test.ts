import { initTRPC } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createPermDock } from "../../src/trpc/index.ts";
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

type Ctx = { readonly user: typeof memberUser | null };

const posts = new Map([
  [ownPost.id, ownPost],
  [otherPost.id, otherPost],
]);

describe("permdock/trpc protect over a permission list and rows", () => {
  const t = initTRPC.context<Ctx>().create();
  const { protect, openapi } = createPermDock<Ctx>(policy, {
    subject: (opts) => opts.ctx.user,
  });
  const appRouter = t.router({
    publishOrUpdate: t.procedure
      .use(
        protect(
          [permissions.post.publish, permissions.post.update],
          () => ownPost,
          { anyOf: true },
        ),
      )
      .mutation(() => "ok"),
    readAndPublish: t.procedure
      .use(
        protect(
          [permissions.post.read, permissions.post.publish],
          () => ownPost,
        ),
      )
      .mutation(() => "ok"),
    updateMany: t.procedure
      .input(z.object({ ids: z.array(z.string()) }))
      .use(
        protect(permissions.post.update, undefined, {
          rows: ({ input }) =>
            z
              .object({ ids: z.array(z.string()) })
              .parse(input)
              .ids.flatMap((id) => {
                const post = posts.get(id);
                return post === undefined ? [] : [post];
              }),
        }),
      )
      .mutation(({ ctx }) => ctx["permdockData"]),
  });

  it("grants anyOf on one permission and denies all-of on a missing one", async () => {
    const caller = appRouter.createCaller({ user: memberUser });
    await expect(caller.publishOrUpdate()).resolves.toBe("ok");
    await expect(caller.readAndPublish()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("needs every row and passes the rows on", async () => {
    await expect(
      appRouter
        .createCaller({ user: adminUser })
        .updateMany({ ids: [ownPost.id, otherPost.id] }),
    ).resolves.toStrictEqual([ownPost, otherPost]);
    await expect(
      appRouter
        .createCaller({ user: memberUser })
        .updateMany({ ids: [ownPost.id, otherPost.id] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      appRouter.createCaller({ user: adminUser }).updateMany({ ids: [] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("emits OpenAPI security for a list", () => {
    expect(
      openapi.security([permissions.post.read, permissions.post.publish], {
        anyOf: true,
      }).openapi.security,
    ).toHaveLength(2);
  });

  it("refuses an empty list when the middleware is built", () => {
    expect(() => protect([])).toThrow(TypeError);
  });
});
