import "reflect-metadata";
import type { ArgumentsHost, ExecutionContext } from "@nestjs/common";
import type { ServerResponse } from "node:http";

import { APP_GUARD, Reflector } from "@nestjs/core";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import type { NestRequest } from "../../src/nest/index.ts";

import { memoryRevocationFeed } from "../../src/core/revocations.ts";
import { sendNestResponse, toRequest } from "../../src/nest/http.ts";
import { createPermDock, decorateMethod } from "../../src/nest/index.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

function fakeRequest(id: string): NestRequest {
  // SAFETY: stub carries the method, url, headers and params the adapter reads.
  return {
    method: "GET",
    url: `/posts/${id}`,
    headers: { host: "localhost" },
    params: { id },
  } as unknown as NestRequest;
}

function httpContext(
  cls: object,
  handler: unknown,
  req: NestRequest,
): ExecutionContext {
  // SAFETY: stub implements every ExecutionContext method the guard calls for http.
  return {
    getType: () => "http",
    getClass: () => cls,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function wsContext(
  cls: object,
  handler: unknown,
  client: object,
  data: unknown,
): ExecutionContext {
  // SAFETY: stub implements every ExecutionContext method the guard calls for ws.
  return {
    getType: () => "ws",
    getClass: () => cls,
    getHandler: () => handler,
    switchToWs: () => ({ getData: () => data, getClient: () => client }),
  } as unknown as ExecutionContext;
}

function methodOf(cls: { readonly prototype: object }, key: string) {
  const descriptor = Object.getOwnPropertyDescriptor(cls.prototype, key);
  if (descriptor === undefined) {
    throw new TypeError(`missing ${key}`);
  }
  return descriptor;
}

describe("permdock/nest Protect", () => {
  it("resolves the actor from the Nest request", async () => {
    const { PermDockGuard } = createPermDock(policy, {
      subject: () => memberUser,
      actor: (req) => ({ id: req.url, kind: "agent" }),
    });
    class Posts {
      public list(): string {
        return "ok";
      }
    }
    const descriptor = methodOf(Posts, "list");
    const req = fakeRequest("p1");
    const guard = new PermDockGuard(new Reflector());
    expect(
      await guard.canActivate(httpContext(Posts, descriptor.value, req)),
    ).toBe(true);
    expect(req.permdock?.subject.actor).toEqual({
      id: "/posts/p1",
      kind: "agent",
    });
  });

  it("stacks class and method rules and rejects a non-callable target", async () => {
    const { PermDockGuard, Protect } = createPermDock(policy, {
      subject: () => memberUser,
    });
    class Posts {
      public update(): string {
        return "ok";
      }
    }
    Protect(permissions.post.list)(Posts);
    const descriptor = methodOf(Posts, "update");
    Protect(permissions.post.read, () => ownPost)(
      Posts.prototype,
      "update",
      descriptor,
    );
    Protect(permissions.post.update, (req) =>
      req.params?.["id"] === "p1" ? ownPost : otherPost,
    )(Posts.prototype, "update", descriptor);
    const guard = new PermDockGuard(new Reflector());
    const req = fakeRequest("p1");
    const context = httpContext(Posts, descriptor.value, req);
    expect(await guard.canActivate(context)).toBe(true);
    expect(await guard.canActivate(context)).toBe(true);
    await expect(
      guard.canActivate(
        httpContext(Posts, descriptor.value, fakeRequest("p2")),
      ),
    ).rejects.toMatchObject({ name: "PermDockHttpError" });
    expect(() =>
      Protect(permissions.post.read)(Posts.prototype, "update", { value: 5 }),
    ).toThrow(TypeError);
  });

  it("registers the guard as APP_GUARD with forRoot({ guard: 'global' })", () => {
    const { PermDockModule, PermDockGuard } = createPermDock(policy, {
      subject: () => memberUser,
    });
    expect(PermDockModule.forRoot({ guard: "global" })).toEqual({
      module: PermDockModule,
      providers: [{ provide: APP_GUARD, useExisting: PermDockGuard }],
    });
    expect(PermDockModule.forRoot().providers).toEqual([]);
  });

  it("applies method decorators in order with decorateMethod", () => {
    class Posts {
      public update(): string {
        return "ok";
      }
    }
    const seen: string[] = [];
    const tag =
      (name: string): MethodDecorator =>
      (_target, key) => {
        seen.push(`${name}:${String(key)}`);
      };
    decorateMethod(Posts, "update", tag("a"), tag("b"));
    expect(seen).toEqual(["a:update", "b:update"]);
    expect(() => {
      decorateMethod(Posts, "missing", tag("c"));
    }).toThrow(/missing is not a method/);
  });

  it("requires reflect-metadata", () => {
    const { Protect } = createPermDock(policy, { subject: () => memberUser });
    const original = Reflect.get(Reflect, "getMetadata");
    Reflect.deleteProperty(Reflect, "getMetadata");
    try {
      expect(() => Protect(permissions.post.list)(class Empty {})).toThrow(
        "reflect-metadata is required for permdock/nest",
      );
    } finally {
      Reflect.set(Reflect, "getMetadata", original);
    }
  });
});

describe("permdock/nest gateway messages", () => {
  it("reuses a connection, checks trusted and loader-less rules, and closes without disconnect", async () => {
    const { PermDockGuard, Protect, connection } = createPermDock(policy, {
      subject: () => memberUser,
    });
    class Gateway {
      public list(): string {
        return "ok";
      }

      public read(): string {
        return "ok";
      }
    }
    const list = methodOf(Gateway, "list");
    Protect(permissions.post.list, undefined, { trusted: true })(
      Gateway.prototype,
      "list",
      list,
    );
    const read = methodOf(Gateway, "read");
    Protect(permissions.post.read, () => ownPost)(
      Gateway.prototype,
      "read",
      read,
    );
    const closes: unknown[] = [];
    const client = {
      close: (code?: number, reason?: string) => {
        closes.push([code, reason]);
      },
    };
    const opened = await connection(client, fakeRequest("handshake"));
    expect(await connection(client, fakeRequest("again"))).toBe(opened);
    const guard = new PermDockGuard(new Reflector());
    expect(
      await guard.canActivate(wsContext(Gateway, list.value, client, {})),
    ).toBe(true);
    await expect(
      guard.canActivate(wsContext(Gateway, read.value, client, {})),
    ).rejects.toMatchObject({ name: "PermDockHttpError" });
    opened.close();
    expect(closes.length).toBeLessThanOrEqual(1);
  });

  it("closes a client without disconnect on revocation", async () => {
    const revocations = memoryRevocationFeed();
    const { connection } = createPermDock(policy, {
      subject: () => memberUser,
      revocations,
    });
    const closes: unknown[] = [];
    const client = {
      close: (code?: number, reason?: string) => {
        closes.push([code, reason]);
      },
    };
    await connection(client, fakeRequest("handshake"));
    await revocations.revoke({ principal: "u1", kind: "session-revoked" });
    expect(closes).toEqual([
      [1008, "https://permdock.com/problems/unauthenticated"],
    ]);
  });
});

describe("permdock/nest exception filter", () => {
  function httpHost(res: unknown): ArgumentsHost {
    // SAFETY: stub implements every ArgumentsHost method the filter calls for http.
    return {
      getType: () => "http",
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ headers: {} }),
      }),
    } as unknown as ArgumentsHost;
  }

  it("refuses an exception it does not map", async () => {
    const { PermDockExceptionFilter } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const filter = new PermDockExceptionFilter();
    await expect(
      filter.catch(new Error("other"), httpHost({})),
    ).rejects.toThrow("unhandled permdock exception");
  });
});

describe("permdock/nest http helpers", () => {
  it("sends to a Fastify reply and rejects an unknown response", async () => {
    const sent: unknown[] = [];
    const reply = {
      code: (status: number) => sent.push(["code", status]),
      header: (key: string, value: string) => sent.push([key, value]),
      send: (body: string) => sent.push(["body", body]),
    };
    await sendNestResponse(reply, new Response("hi", { status: 202 }));
    expect(sent).toEqual([
      ["code", 202],
      ["content-type", "text/plain;charset=UTF-8"],
      ["body", "hi"],
    ]);
    await expect(
      sendNestResponse({ code: "no" }, new Response("x")),
    ).rejects.toThrow(TypeError);
    await expect(sendNestResponse(null, new Response("x"))).rejects.toThrow(
      TypeError,
    );
  });

  it("sends to a node ServerResponse", async () => {
    const chunks: unknown[] = [];
    const res = {
      statusCode: 0,
      setHeader: () => undefined,
      end: (chunk: unknown) => chunks.push(chunk),
    };
    // SAFETY: sendResponse uses only statusCode, setHeader and end.
    await sendNestResponse(
      res as unknown as ServerResponse,
      new Response("ok"),
    );
    expect(res.statusCode).toBe(200);
  });

  it("streams a Fastify raw body and drops a body without a stream", async () => {
    const raw = new PassThrough();
    // SAFETY: a Fastify-like request: headers, method and url plus the raw stream.
    const fastifyReq = {
      headers: { host: "api.test" },
      method: "POST",
      url: "/x",
      raw,
    } as unknown as NestRequest;
    const request = toRequest(fastifyReq);
    const text = request.text();
    raw.end("streamed");
    // SAFETY: a Fastify-like request without a readable raw stream.
    const bare = {
      headers: { host: "api.test" },
      method: "POST",
      url: "/x",
      raw: {},
    } as unknown as NestRequest;
    expect([await text, await toRequest(bare).text()]).toEqual([
      "streamed",
      "",
    ]);
  });
});
