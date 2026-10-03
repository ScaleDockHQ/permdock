import "reflect-metadata";
import type { ArgumentsHost, ExecutionContext } from "@nestjs/common";

import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";

import type { NestRequest } from "../../src/nest/index.ts";

import { PermDockDeniedError } from "../../src/core/errors.ts";
import { memoryRevocationFeed } from "../../src/core/revocations.ts";
import { createPermDock } from "../../src/nest/index.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

class Gateway {
  public update(): string {
    return "ok";
  }

  public open(): string {
    return "ok";
  }
}

function contextOf(
  type: string,
  handler: () => unknown,
  data: unknown = {},
  owner: new () => unknown = Gateway,
): ExecutionContext {
  // SAFETY: stub implements every ExecutionContext method the guard calls for rpc and ws.
  return {
    getType: () => type,
    getClass: () => owner,
    getHandler: () => handler,
    getArgs: () => [data],
    getArgByIndex: () => data,
    switchToHttp: () => {
      throw new TypeError("not http");
    },
    switchToRpc: () => ({ getData: () => data, getContext: () => ({}) }),
    switchToWs: () => ({ getData: () => data, getClient: () => ({}) }),
  } as unknown as ExecutionContext;
}

function hostOf(type: string, client: unknown): ArgumentsHost {
  // SAFETY: stub implements every ArgumentsHost method the exception filter calls.
  return {
    getType: () => type,
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToHttp: () => {
      throw new TypeError("not http");
    },
    switchToRpc: () => ({ getData: () => ({}), getContext: () => ({}) }),
    switchToWs: () => ({ getData: () => ({}), getClient: () => client }),
  } as unknown as ArgumentsHost;
}

function fakeRequest(id: string): NestRequest {
  // SAFETY: stub carries the method, url, headers and params the adapter reads.
  return {
    method: "GET",
    url: `/posts/${id}`,
    headers: { host: "localhost" },
    params: { id },
  } as unknown as NestRequest;
}

describe("permdock/nest gateway connections", () => {
  it("decides messages against the client connection and disconnects on revocation", async () => {
    const revocations = memoryRevocationFeed();
    const { PermDockGuard, Protect, connection } = createPermDock(policy, {
      subject: () => memberUser,
      revocations,
      // SAFETY: message() below builds ws contexts whose data is { id }.
      request: (context) =>
        fakeRequest(
          (context.switchToWs().getData() as { readonly id: string }).id,
        ),
    });
    class Posts {
      public update(): string {
        return "ok";
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      Posts.prototype,
      "update",
    )!;
    Protect(permissions.post.update, (req) =>
      req.params?.["id"] === "p1" ? ownPost : otherPost,
    )(Posts.prototype, "update", descriptor);
    const events: [string, unknown][] = [];
    const disconnects: unknown[] = [];
    const client = {
      emit: (event: string, payload: unknown) => {
        events.push([event, payload]);
      },
      disconnect: (close?: boolean) => {
        disconnects.push(close);
      },
    };
    await connection(client, fakeRequest("handshake"));
    const guard = new PermDockGuard(new Reflector());
    // SAFETY: descriptor.value is Posts.update; the stub extends contextOf with the ws client.
    const message = (id: string): ExecutionContext =>
      ({
        ...contextOf("ws", descriptor.value as () => unknown, { id }),
        getClass: () => Posts,
        switchToWs: () => ({
          getData: () => ({ id }),
          getClient: () => client,
        }),
      }) as unknown as ExecutionContext;

    await expect(guard.canActivate(message("p1"))).resolves.toBe(true);
    await expect(guard.canActivate(message("p2"))).rejects.toThrow(
      "permdock denied",
    );

    await revocations.revoke({ principal: "u1", kind: "session-revoked" });
    expect(events).toEqual([
      [
        "permdock:error",
        expect.objectContaining({ status: 401, detail: "session-revoked" }),
      ],
    ]);
    expect(disconnects).toEqual([true]);
    await expect(guard.canActivate(message("p1"))).rejects.toThrow(
      "permdock denied",
    );
  });
});

describe("permdock/nest outside HTTP", () => {
  it("denies a protected handler in a context it cannot read", async () => {
    const { PermDockGuard, Protect } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const descriptor = Object.getOwnPropertyDescriptor(
      Gateway.prototype,
      "update",
    )!;
    Protect(permissions.post.update, () => ownPost)(
      Gateway.prototype,
      "update",
      descriptor,
    );
    const guard = new PermDockGuard(new Reflector());
    // SAFETY: descriptor.value is the Gateway.update method read above.
    await expect(
      guard.canActivate(contextOf("rpc", descriptor.value as () => unknown)),
    ).resolves.toBe(false);
    // SAFETY: descriptor.value is the Gateway.update method read above.
    await expect(
      guard.canActivate(contextOf("ws", descriptor.value as () => unknown)),
    ).resolves.toBe(false);
  });

  it("lets an unprotected handler through", async () => {
    const { PermDockGuard } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const guard = new PermDockGuard(new Reflector());
    // SAFETY: Gateway.prototype.open is the zero-argument method declared above.
    await expect(
      guard.canActivate(
        contextOf("rpc", Reflect.get(Gateway.prototype, "open") as () => void),
      ),
    ).resolves.toBe(true);
  });

  it("protects a mapped context through the request option", async () => {
    const { PermDockGuard, Protect } = createPermDock(policy, {
      subject: () => memberUser,
      // SAFETY: context() below builds rpc contexts whose data is { id }.
      request: (context) =>
        fakeRequest(
          (context.switchToRpc().getData() as { readonly id: string }).id,
        ),
    });
    class Mapped {
      public update(): string {
        return "ok";
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      Mapped.prototype,
      "update",
    )!;
    Protect(permissions.post.update, (req) =>
      req.params?.["id"] === "p1" ? ownPost : otherPost,
    )(Mapped.prototype, "update", descriptor);
    const guard = new PermDockGuard(new Reflector());
    // SAFETY: descriptor.value is the Mapped.update method read above.
    const context = (id: string): ExecutionContext =>
      contextOf("rpc", descriptor.value as () => unknown, { id }, Mapped);
    await expect(guard.canActivate(context("p1"))).resolves.toBe(true);
    await expect(guard.canActivate(context("p2"))).rejects.toMatchObject({
      name: "PermDockHttpError",
    });
  });

  it("emits Problem Details to a WebSocket client instead of throwing", async () => {
    const { PermDockExceptionFilter } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const filter = new PermDockExceptionFilter();
    const sent: unknown[] = [];
    const client = {
      emit: (event: string, payload: unknown) => sent.push([event, payload]),
    };
    const denied = new PermDockDeniedError({
      decision: { outcome: "denied", denials: [], alternatives: [] },
      permission: permissions.post.update.key,
      scope: permissions.post.update.scope,
      resource: { type: "post", id: "p2" },
      subject: { principal: null, context: {} },
      message: "denied",
    });
    await filter.catch(denied, hostOf("ws", client));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject([
      "exception",
      { status: "error", problem: { status: 403 } },
    ]);
    await expect(filter.catch(denied, hostOf("rpc", {}))).rejects.toBe(denied);
  });
});
