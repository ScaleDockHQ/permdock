import { OpenAPIGenerator, openapi as route } from "@orpc/openapi";
import { call, ORPCError } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineOperations } from "../../src/index.ts";
import { createPermDock } from "../../src/orpc/index.ts";
import {
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

const operations = defineOperations(permissions, {
  "post.update": {
    permission: permissions.post.update,
    data: (input: { readonly id: string }) => posts.get(input.id),
    meta: { title: "Update a post" },
  },
  "post.list": { permission: permissions.post.list },
});

const byId = z.object({ id: z.string() });

function factory() {
  return createPermDock<Ctx>(policy, { subject: (opts) => opts.context.user });
}

describe("operationsRouter", () => {
  it("guards each procedure with its operation's permission and row", async () => {
    const { operationsRouter } = factory();
    const router = operationsRouter(operations, {
      "post.update": {
        input: byId,
        handler: ({ input, context }) => ({
          id: input.id,
          loaded: context.permdockData,
        }),
      },
      "post.list": {
        handler: ({ context }) =>
          context.permdock.filter(permissions.post.read, [...posts.values()])
            .length,
      },
    });
    const context = { user: memberUser };
    await expect(
      call(router["post.update"], { id: ownPost.id }, { context }),
    ).resolves.toStrictEqual({ id: ownPost.id, loaded: ownPost });
    await expect(
      call(router["post.update"], { id: otherPost.id }, { context }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      data: { status: 403, permission: "post.update" },
    });
    await expect(
      // @ts-expect-error -- the input schema takes a string id
      call(router["post.update"], { id: 1 }, { context }),
    ).rejects.toBeInstanceOf(ORPCError);
    await expect(
      call(router["post.list"], undefined, { context }),
    ).resolves.toBe(2);
    await expect(
      call(router["post.list"], undefined, { context: { user: null } }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("puts the operation's security and x-permdock-permissions on the generated document", async () => {
    const { operationsRouter, openapi } = factory();
    const router = operationsRouter(
      operations,
      {
        "post.update": { input: byId, handler: () => "ok" },
        "post.list": { handler: () => "ok" },
      },
      {
        meta: (operation) => [
          route({
            operationId: operation.name,
            summary: operation.meta.title,
            spec: openapi.spec(operation.permission),
          }),
        ],
      },
    );
    const document = await new OpenAPIGenerator().generate(router);
    expect(document.paths?.["/post.update"]?.post).toMatchObject({
      operationId: "post.update",
      summary: "Update a post",
      security: [{ oauth2: ["post:update"] }],
      "x-permdock-permissions": ["post.update"],
    });
    expect(document.paths?.["/post.list"]?.post).toMatchObject({
      operationId: "post.list",
      "x-permdock-permissions": ["post.list"],
    });
  });

  it("throws at definition time for a route and operation that do not pair up", () => {
    const { operationsRouter } = factory();
    const handler = () => "ok";
    expect(() =>
      operationsRouter(operations, {
        "post.update": { input: byId, handler },
        // @ts-expect-error -- names no operation
        "post.remove": { handler },
      }),
    ).toThrow('"post.remove" is not an operation');
    expect(() =>
      // @ts-expect-error -- post.list has no route
      operationsRouter(operations, { "post.update": { input: byId, handler } }),
    ).toThrow('operation "post.list" has no route');
    expect(() =>
      operationsRouter(operations, {
        // @ts-expect-error -- post.update loads a row, so its route needs an input schema
        "post.update": { handler },
        "post.list": { handler },
      }),
    ).toThrow("its route needs an input schema");
    expect(() =>
      operationsRouter(operations, {
        "post.update": { input: byId, handler },
        // @ts-expect-error -- the handler must be a function
        "post.list": { handler: "ok" },
      }),
    ).toThrow('the route for operation "post.list" needs a handler function');
    expect(() =>
      operationsRouter(operations, {
        "post.update": { input: byId, handler },
        // @ts-expect-error -- a route is an object
        "post.list": null,
      }),
    ).toThrow('the route for operation "post.list" needs a handler function');
  });
});
