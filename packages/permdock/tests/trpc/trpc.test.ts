import { initTRPC, TRPCError, tracked } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { memoryRevocationFeed } from "../../src/core/revocations.ts";
import { createPermDock, errorFormatter } from "../../src/trpc/index.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

type Ctx = { readonly user: typeof memberUser | null };

async function shapeOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    // SAFETY: tRPC callers reject with a TRPCError, wrapping any other thrown value.
    return errorFormatter({
      shape: { data: { code: "X" } },
      error: error as TRPCError,
    });
  }
  throw new Error("expected a rejection");
}

function channel<T>() {
  const queue: T[] = [];
  let wake: (() => void) | undefined;
  const nextPush = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  };
  return {
    push(...items: T[]): void {
      queue.push(...items);
      wake?.();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) {
          await nextPush();
        } else {
          yield next;
        }
      }
    },
  };
}

describe("permdock/trpc subscriptions", () => {
  it("drops unreadable items, follows a demotion and ends on session revocation", async () => {
    const t = initTRPC.context<Ctx>().create();
    const revocations = memoryRevocationFeed();
    const { protect } = createPermDock<Ctx>(policy, {
      subject: (opts) => opts.ctx.user,
      revocations,
    });
    const posts = channel<typeof ownPost>();
    const appRouter = t.router({
      posts: t.procedure
        .use(
          protect(permissions.post.list, undefined, {
            items: permissions.post.update,
          }),
        )
        .subscription(async function* () {
          for await (const post of posts.drain()) {
            yield tracked(post.id, post);
          }
        }),
    });
    const user = { ...memberUser, roles: [...memberUser.roles] };
    const stream = await appRouter.createCaller({ user }).posts();
    // SAFETY: the posts procedure is a subscription, whose caller result is an async iterable.
    const iterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();

    posts.push(otherPost, ownPost);
    const first = await iterator.next();
    expect(first.done).toBe(false);
    // SAFETY: tracked() yields an [id, data, ...] tuple, and done is false above.
    expect((first.value as readonly unknown[])[1]).toEqual(ownPost);

    const pending = iterator.next();
    await revocations.revoke({ principal: "u1", kind: "session-revoked" });
    await expect(pending).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "session-revoked",
    });
  });

  it("ends a subscription whose opening permission a demotion removed", async () => {
    const t = initTRPC.context<Ctx>().create();
    const revocations = memoryRevocationFeed();
    const { protect } = createPermDock<Ctx>(policy, {
      subject: (opts) => opts.ctx.user,
      revocations,
    });
    const posts = channel<typeof ownPost>();
    const appRouter = t.router({
      drafts: t.procedure
        .use(protect(permissions.post.publish))
        .subscription(() => posts.drain()),
    });
    const user = { id: "u2", orgId: "o1", roles: ["admin"] };
    const stream = await appRouter.createCaller({ user }).drafts();
    // SAFETY: the drafts procedure is a subscription, whose caller result is an async iterable.
    const iterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    posts.push(ownPost);
    await expect(iterator.next()).resolves.toMatchObject({ value: ownPost });
    const pending = iterator.next();
    user.roles = ["member"];
    await revocations.revoke({ principal: "u2", kind: "changed" });
    await expect(pending).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("permdock/trpc", () => {
  it("grants and denies through createCaller", async () => {
    const t = initTRPC.context<Ctx>().create();
    const { permdock, protect } = createPermDock<Ctx>(policy, {
      subject: (opts) => opts.ctx.user,
    });
    const procedure = t.procedure.use(permdock());
    const appRouter = t.router({
      update: procedure
        .input(z.object({ id: z.string() }))
        .use(
          protect(permissions.post.update, ({ input }) =>
            typeof input === "object" &&
            input !== null &&
            "id" in input &&
            input.id === "p1"
              ? ownPost
              : otherPost,
          ),
        )
        .mutation(({ ctx }) => ({
          ok: true as const,
          via: ctx["permdock"].subject.principal?.id,
        })),
    });
    const caller = appRouter.createCaller({ user: memberUser });

    await expect(caller.update({ id: "p1" })).resolves.toEqual({
      ok: true,
      via: "u1",
    });

    try {
      await caller.update({ id: "p2" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      // SAFETY: toBeInstanceOf above checked the error is a TRPCError.
      const denied = error as TRPCError;
      expect(denied.code).toBe("FORBIDDEN");
      expect(denied.cause).toEqual(
        expect.objectContaining({
          status: 403,
        }),
      );
    }
  });

  it("maps assert inside a resolver to FORBIDDEN with the Problem", async () => {
    const t = initTRPC.context<Ctx>().create();
    const { permdock } = createPermDock<Ctx>(policy, {
      subject: (opts) => opts.ctx.user,
    });
    const appRouter = t.router({
      update: t.procedure.use(permdock()).mutation(({ ctx }) => {
        ctx["permdock"].assert(permissions.post.update, otherPost);
        return { ok: true as const };
      }),
    });
    const shape = await shapeOf(() =>
      appRouter.createCaller({ user: memberUser }).update(),
    );
    expect(shape.data).toEqual(
      expect.objectContaining({
        status: 403,
        type: "https://permdock.dev/problems/denied",
      }),
    );
  });

  it("throws UNAUTHORIZED for an anonymous caller", async () => {
    const t = initTRPC.context<Ctx>().create();
    const { permdock, protect } = createPermDock<Ctx>(policy, {
      subject: (opts) => opts.ctx.user,
    });
    const procedure = t.procedure.use(permdock());
    const appRouter = t.router({
      read: procedure
        .use(protect(permissions.post.read, () => ownPost))
        .query(() => ({ ok: true as const })),
    });
    const caller = appRouter.createCaller({ user: null });

    try {
      await caller.read();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      // SAFETY: toBeInstanceOf above checked the error is a TRPCError.
      expect((error as TRPCError).code).toBe("UNAUTHORIZED");
    }
  });

  it("answers AuthZEN evaluations over Fetch", async () => {
    const { permdockHandler, openapi } = createPermDock<Ctx>(policy, {
      subject: () => memberUser,
    });
    const response = await permdockHandler(
      new Request("http://localhost/permdock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          evaluations: [
            {
              resource: { type: "post", properties: ownPost },
              action: { name: "update" },
            },
          ],
        }),
      }),
    );
    // SAFETY: AuthZEN response JSON produced by permdockHandler under test.
    const body = (await response.json()) as {
      readonly evaluations: readonly { readonly decision: boolean }[];
    };
    expect(body.evaluations[0]?.decision).toBe(true);

    const security = openapi.security(permissions.post.delete);
    expect(security.openapi.protect).toBe(true);
    expect(security.openapi["x-permdock-permissions"]).toEqual([
      permissions.post.delete.key,
    ]);
  });

  it("merges only PermDock problems into the error shape", async () => {
    const t = initTRPC.context<Ctx>().create({ errorFormatter });
    const { protect } = createPermDock<Ctx>(policy, {
      subject: (opts) => opts.ctx.user,
    });
    const router = t.router({
      publish: t.procedure
        .use(protect(permissions.post.publish))
        .query(() => "ok"),
      crash: t.procedure.query(() => {
        throw Object.assign(new Error("db down"), {
          detail: "password=hunter2 host=db.internal",
          status: 500,
        });
      }),
    });
    const caller = router.createCaller({ user: memberUser });
    const denied = await shapeOf(() => caller.publish());
    expect(denied.data).toMatchObject({ code: "X", status: 403 });
    const crashed = await shapeOf(() => caller.crash());
    expect(crashed.data).toEqual({ code: "X" });
  });
});
