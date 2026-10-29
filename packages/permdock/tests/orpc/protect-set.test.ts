import { call, ORPCError, os } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createPermDock, permissionOf } from "../../src/orpc/index.ts";
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

type Ctx = { readonly user: typeof memberUser | null };

const byIds = z.object({ ids: z.array(z.string()) });
const posts = new Map([
  [ownPost.id, ownPost],
  [otherPost.id, otherPost],
]);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("permdock/orpc protect over a permission list", () => {
  const { protect, openapi } = createPermDock<Ctx>(policy, {
    subject: (opts) => opts.context.user,
  });

  const allOf = os
    .$context<Ctx>()
    .use(
      protect(
        [permissions.post.read, permissions.post.publish],
        () => otherPost,
      ),
    )
    .handler(() => ({ ok: true as const }));
  const anyOf = os
    .$context<Ctx>()
    .use(
      protect(
        [permissions.post.publish, permissions.post.update],
        () => ownPost,
        { anyOf: true },
      ),
    )
    .handler(() => ({ ok: true as const }));

  it("needs every permission by default", async () => {
    const error = await rejection(
      call(allOf, undefined, { context: { user: memberUser } }),
    );
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code: "FORBIDDEN",
      data: { permission: "post.publish" },
    });
  });

  it("needs one permission with anyOf", async () => {
    await expect(
      call(anyOf, undefined, { context: { user: memberUser } }),
    ).resolves.toStrictEqual({ ok: true });
  });

  it("reports the first permission when anyOf grants none", async () => {
    const none = os
      .$context<Ctx>()
      .use(
        protect(
          [permissions.post.publish, permissions.post.update],
          () => otherPost,
          { anyOf: true },
        ),
      )
      .handler(() => ({ ok: true as const }));
    const error = await rejection(
      call(none, undefined, { context: { user: memberUser } }),
    );
    expect(error).toMatchObject({
      code: "FORBIDDEN",
      data: { permission: "post.publish" },
    });
  });

  it("refuses an empty list when the middleware is built", () => {
    expect(() => protect([], () => ownPost)).toThrow(TypeError);
  });

  it("tags the procedure with the list", () => {
    const list = permissionOf(allOf);
    expect(Array.isArray(list)).toBe(true);
    expect(
      Array.isArray(list) ? list.map((permission) => permission.key) : [],
    ).toStrictEqual(["post.read", "post.publish"]);
  });

  it("writes one security requirement for all-of and one per permission for anyOf", () => {
    const list = [permissions.post.read, permissions.post.publish] as const;
    const all = openapi.security(list);
    const any = openapi.security(list, { anyOf: true });
    expect(all.security).toHaveLength(1);
    expect(any.security).toHaveLength(2);
    expect(all["x-permdock-permissions"]).toStrictEqual([
      "post.read",
      "post.publish",
    ]);
    expect(any["x-permdock-permissions"]).toStrictEqual([
      "post.read",
      "post.publish",
    ]);
  });
});

describe("permdock/orpc protect over rows", () => {
  const { protect } = createPermDock<Ctx>(policy, {
    subject: (opts) => opts.context.user,
  });
  const updateMany = os
    .$context<Ctx>()
    .input(byIds)
    .use(
      protect(permissions.post.update, undefined, {
        rows: ({ input }) =>
          byIds.parse(input).ids.flatMap((id) => {
            const post = posts.get(id);
            return post === undefined ? [] : [post];
          }),
      }),
    )
    .handler(({ context }) => context.permdockData);

  it("grants when every row is granted and passes the rows on", async () => {
    await expect(
      call(updateMany, { ids: [ownPost.id] }, { context: { user: adminUser } }),
    ).resolves.toStrictEqual([ownPost]);
    await expect(
      call(
        updateMany,
        { ids: [ownPost.id, otherPost.id] },
        { context: { user: adminUser } },
      ),
    ).resolves.toStrictEqual([ownPost, otherPost]);
  });

  it("denies when one row is denied and reports that row", async () => {
    const error = await rejection(
      call(
        updateMany,
        { ids: [ownPost.id, otherPost.id] },
        { context: { user: memberUser } },
      ),
    );
    expect(error).toMatchObject({
      code: "FORBIDDEN",
      data: {
        permission: "post.update",
        detail: expect.stringMatching(
          /^post\.update denied: member \(condition\)\./u,
        ),
      },
    });
  });

  it("answers NOT_FOUND when no row loads", async () => {
    const error = await rejection(
      call(updateMany, { ids: ["p404"] }, { context: { user: adminUser } }),
    );
    expect(error).toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses data and rows together", async () => {
    const both = os
      .$context<Ctx>()
      .use(
        protect(permissions.post.update, () => ownPost, {
          rows: () => [ownPost],
        }),
      )
      .handler(() => ({ ok: true as const }));
    await expect(
      call(both, undefined, { context: { user: adminUser } }),
    ).rejects.toThrow(/data or rows, not both/u);
  });
});
