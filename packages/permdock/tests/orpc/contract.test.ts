import { oc } from "@orpc/contract";
import { call, implement, ORPCError } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { securityFor } from "../../src/openapi/index.ts";
import { createPermDock } from "../../src/orpc/index.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

type Ctx = { readonly user: typeof memberUser | null };

const byId = z.object({ id: z.string() });

const contract = {
  posts: {
    update: oc.input(byId).output(z.object({ id: z.string() })),
  },
};

describe("permdock/orpc with a contract", () => {
  it("protects a contract procedure with a declared output", async () => {
    const { permdock, protect } = createPermDock<Ctx>(policy, {
      subject: (opts) => opts.context.user,
    });
    const os = implement(contract).$context<Ctx>();
    const posts = new Map([
      [ownPost.id, ownPost],
      [otherPost.id, otherPost],
    ]);
    const update = os
      .use(permdock())
      .posts.update.use(
        protect(permissions.post.update, ({ input }) =>
          posts.get(byId.parse(input).id),
        ),
      )
      .handler(({ input }) => ({ id: input.id }));

    await expect(
      call(update, { id: ownPost.id }, { context: { user: memberUser } }),
    ).resolves.toEqual({ id: ownPost.id });
    await expect(
      call(update, { id: otherPost.id }, { context: { user: memberUser } }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it("gives the contract the security fragment the server hook gives", () => {
    const { openapi } = createPermDock<Ctx>(policy, {
      subject: (opts) => opts.context.user,
    });
    expect(securityFor(permissions.post.update)).toEqual(
      openapi.security(permissions.post.update),
    );
  });
});
