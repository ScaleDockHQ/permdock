import { call, ORPCError, os } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { memoryLimitStore } from "../../src/core/limits.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";
import { createPermDock } from "../../src/orpc/index.ts";
import { verifyWebBotAuth } from "../../src/server/web-bot-auth.ts";
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
    return error instanceof ORPCError ? String(error.code) : "not-orpc";
  }
  return "resolved";
}

describe("permdock/orpc request discovery and failures", () => {
  it("reads ctx.request and rejects a bad Web Bot Auth signature", async () => {
    const { permdock } = createPermDock<Ctx>(policy, {
      subject: () => memberUser,
      webBotAuth: (request) =>
        verifyWebBotAuth(request, {
          verify: true,
          keys: { lookup: () => undefined },
        }),
    });
    const read = os
      .$context<Ctx>()
      .use(permdock())
      .handler(() => "ok");
    const request = new Request("http://localhost/orpc/read", {
      headers: signed,
    });
    expect([
      await codeOf(() => call(read, undefined, { context: { request } })),
      await codeOf(() =>
        call(read, undefined, { context: { req: "not a request" } }),
      ),
    ]).toEqual(["FORBIDDEN", "resolved"]);
  });

  it("treats a null or throwing request option as no request", async () => {
    const results = [];
    for (const request of [
      () => null,
      () => {
        throw new Error("no request");
      },
    ]) {
      const { permdock } = createPermDock<Ctx>(policy, {
        subject: () => memberUser,
        request,
      });
      const read = os
        .$context<Ctx>()
        .use(permdock())
        .handler(({ context }) => context.permdock.subject.principal?.id);
      results.push(await call(read, undefined, { context: {} }));
    }
    expect(results).toEqual(["u1", "u1"]);
  });

  it("rethrows a build failure from permdock()", async () => {
    const { permdock } = createPermDock<Ctx>(policy, {
      subject: () => memberUser,
      pdp: async () => {
        throw new Error("pdp factory failed");
      },
    });
    const read = os
      .$context<Ctx>()
      .use(permdock())
      .handler(() => "ok");
    const error: unknown = await call(read, undefined, { context: {} }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
  });

  it("maps invalid data to BAD_REQUEST and a missing row to NOT_FOUND", async () => {
    const { permdock, protect } = createPermDock<Ctx>(policy, {
      subject: () => memberUser,
    });
    const invalid = os
      .$context<Ctx>()
      .use(permdock())
      .handler(({ context }) => {
        context.permdock.assert(permissions.post.update, { id: 5 });
        return "ok";
      });
    const missing = os
      .$context<Ctx>()
      .use(protect(permissions.post.read, () => null))
      .handler(() => "ok");
    expect([
      await codeOf(() => call(invalid, undefined, { context: {} })),
      await codeOf(() => call(missing, undefined, { context: {} })),
    ]).toEqual(["BAD_REQUEST", "NOT_FOUND"]);
  });

  it("opens an event iterator connection with the row loader", async () => {
    const { protect } = createPermDock<Ctx>(policy, {
      subject: () => memberUser,
    });
    let loads = 0;
    const feed = os
      .$context<Ctx>()
      .use(
        protect(permissions.post.update, () => {
          loads += 1;
          return ownPost;
        }),
      )
      .handler(async function* () {
        yield ownPost.id;
      });
    // SAFETY: feed is an async generator handler, so call() resolves to its async iterable.
    const stream = (await call(feed, undefined, {
      context: {},
    })) as AsyncIterable<unknown>;
    const items: unknown[] = [];
    for await (const item of stream) {
      items.push(item);
    }
    expect({ items, loaded: loads >= 1 }).toEqual({
      items: ["p1"],
      loaded: true,
    });
  });

  it("serves the snapshot on GET from the handler", async () => {
    const { permdockHandler } = createPermDock<Ctx>(policy, {
      subject: () => memberUser,
    });
    const response = await permdockHandler(
      new Request("http://localhost/permdock"),
    );
    expect(response.status).toBe(200);
  });
});

describe("permdock/orpc limit codes", () => {
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
    const codes = [];
    for (const limits of [memoryLimitStore(), undefined]) {
      const { protect } = createPermDock<Ctx>(limitedPolicy, {
        subject: () => ({ id: "u1", roles: ["member"] }),
        ...(limits === undefined ? {} : { limits }),
      });
      const run = os
        .$context<Ctx>()
        .use(protect(limited.report.export, () => ({ id: "r1" })))
        .handler(() => "ok");
      const first = await codeOf(() => call(run, undefined, { context: {} }));
      const second = await codeOf(() => call(run, undefined, { context: {} }));
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
