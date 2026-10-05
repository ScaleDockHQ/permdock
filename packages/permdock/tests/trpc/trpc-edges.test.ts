import { initTRPC, TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { memoryLimitStore } from "../../src/core/limits.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";
import { verifyWebBotAuth } from "../../src/server/web-bot-auth.ts";
import { createPermDock } from "../../src/trpc/index.ts";
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

type Ctx = { readonly request?: unknown; readonly req?: unknown };

const signed = {
  "Signature-Input":
    'sig1=("@method");created=1700000000;keyid="bot-1";alg="ed25519"',
  Signature: "sig1=:AAAA:",
  "Signature-Agent": '"https://agents.example.com"',
};

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof TRPCError ? error.code : "not-trpc";
  }
  return "resolved";
}

describe("permdock/trpc request discovery and failures", () => {
  it("reads ctx.request and rejects a bad Web Bot Auth signature", async () => {
    const t = initTRPC.context<Ctx>().create();
    const { permdock } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: (request) =>
        verifyWebBotAuth(request, {
          verify: true,
          keys: { lookup: () => undefined },
        }),
    });
    const router = t.router({
      read: t.procedure.use(permdock()).query(() => "ok"),
    });
    const request = new Request("http://localhost/trpc/read", {
      headers: signed,
    });
    expect(await codeOf(() => router.createCaller({ request }).read())).toBe(
      "FORBIDDEN",
    );
    expect(
      await codeOf(() => router.createCaller({ req: "not a request" }).read()),
    ).toBe("resolved");
  });

  it("resolves the actor and wraps the instance with otel", async () => {
    const t = initTRPC.context<Ctx>().create();
    const wrapped: string[] = [];
    const { permdock } = createPermDock(policy, {
      subject: () => memberUser,
      actor: (opts) => ({ id: opts.type, kind: "agent" }),
      otel: (instance) => {
        wrapped.push(instance.subject.principal?.id ?? "anonymous");
        return instance;
      },
    });
    const router = t.router({
      read: t.procedure
        .use(permdock())
        .query(({ ctx }) => ctx["permdock"].subject.actor),
    });
    const request = new Request("http://localhost/trpc/read");
    expect(await router.createCaller({ request }).read()).toEqual({
      id: "query",
      kind: "agent",
    });
    expect(wrapped).toEqual(["u1"]);
  });

  it("treats a null or throwing request option as no request", async () => {
    const t = initTRPC.context<Ctx>().create();
    const results = [];
    for (const request of [
      () => null,
      () => {
        throw new Error("no request");
      },
    ]) {
      const { permdock } = createPermDock(policy, {
        subject: () => memberUser,
        request,
      });
      const router = t.router({
        read: t.procedure.use(permdock()).query(
          ({ ctx }) =>
            // SAFETY: the permdock() middleware above adds ctx.permdock.
            (
              ctx as unknown as {
                readonly permdock: {
                  readonly subject: {
                    readonly principal: { readonly id: string } | null;
                  };
                };
              }
            ).permdock.subject.principal?.id,
        ),
      });
      results.push(await router.createCaller({}).read());
    }
    expect(results).toEqual(["u1", "u1"]);
  });

  it("rethrows a build failure from permdock()", async () => {
    const t = initTRPC.context<Ctx>().create();
    const { permdock } = createPermDock(policy, {
      subject: () => memberUser,
      pdp: async () => {
        throw new Error("pdp factory failed");
      },
    });
    const router = t.router({
      read: t.procedure.use(permdock()).query(() => "ok"),
    });
    expect(await codeOf(() => router.createCaller({}).read())).toBe(
      "INTERNAL_SERVER_ERROR",
    );
  });

  it("maps invalid row data in a resolver to BAD_REQUEST", async () => {
    const t = initTRPC.context<Ctx>().create();
    const { permdock } = createPermDock(policy, { subject: () => memberUser });
    const router = t.router({
      update: t.procedure.use(permdock()).mutation(({ ctx }) => {
        // SAFETY: the permdock() middleware above adds ctx.permdock.
        const scoped = ctx as unknown as {
          readonly permdock: {
            readonly assert: (permission: unknown, data: unknown) => void;
          };
        };
        scoped.permdock.assert(permissions.post.update, { id: 5 });
        return "ok";
      }),
    });
    expect(await codeOf(() => router.createCaller({}).update())).toBe(
      "BAD_REQUEST",
    );
  });

  it("maps a missing row to NOT_FOUND", async () => {
    const t = initTRPC.context<Ctx>().create();
    const { protect } = createPermDock(policy, { subject: () => memberUser });
    const router = t.router({
      read: t.procedure
        .use(protect(permissions.post.read, () => null))
        .query(() => "ok"),
    });
    expect(await codeOf(() => router.createCaller({}).read())).toBe(
      "NOT_FOUND",
    );
  });

  it("opens a subscription connection with the row loader", async () => {
    const t = initTRPC.context<Ctx>().create();
    const { protect } = createPermDock(policy, { subject: () => memberUser });
    let loads = 0;
    const router = t.router({
      post: t.procedure
        .use(
          protect(permissions.post.update, () => {
            loads += 1;
            return ownPost;
          }),
        )
        .subscription(async function* () {
          yield ownPost.id;
        }),
    });
    const stream = await router.createCaller({}).post();
    const items: unknown[] = [];
    // SAFETY: a subscription caller resolves to an async iterable.
    for await (const item of stream as AsyncIterable<unknown>) {
      items.push(item);
    }
    expect({ items, loaded: loads >= 1 }).toEqual({
      items: ["p1"],
      loaded: true,
    });
  });

  it("serves the snapshot on GET from the handler", async () => {
    const { permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const response = await permdockHandler(
      new Request("http://localhost/permdock"),
    );
    expect(response.status).toBe(200);
  });
});

describe("permdock/trpc limit codes", () => {
  const limited = definePermissions({
    report: resource(z.object({ id: z.string() }), { actions: ["export"] }),
  });
  const limitedPolicy = definePolicy(limited, {
    roles: [
      role("member", [
        allow(limited.report.export, { limit: { count: 1, per: "hour" } }),
      ]),
    ],
    subject: (user: {
      readonly id: string;
      readonly roles: readonly string[];
    }) => user,
  });

  it("maps an exhausted limit to TOO_MANY_REQUESTS and a missing store to SERVICE_UNAVAILABLE", async () => {
    const t = initTRPC.context<Ctx>().create();
    const codes = [];
    for (const limits of [memoryLimitStore(), undefined]) {
      const { protect } = createPermDock(limitedPolicy, {
        subject: () => ({ id: "u1", roles: ["member"] }),
        ...(limits === undefined ? {} : { limits }),
      });
      const router = t.router({
        run: t.procedure
          .use(protect(limited.report.export, () => ({ id: "r1" })))
          .query(() => "ok"),
      });
      const first = await codeOf(() => router.createCaller({}).run());
      const second = await codeOf(() => router.createCaller({}).run());
      codes.push(first, second);
    }
    expect(codes).toEqual([
      "resolved",
      "TOO_MANY_REQUESTS",
      "SERVICE_UNAVAILABLE",
      "SERVICE_UNAVAILABLE",
    ]);
  });
});
