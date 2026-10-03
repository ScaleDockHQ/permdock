import "reflect-metadata";
import type { Type } from "@nestjs/common";
import type { Server } from "node:http";

import { Controller, Delete, Get, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";

import { createPermDock } from "../../src/nest/index.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const apps: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function applyMethod(
  cls: new () => unknown,
  key: string,
  decorator: MethodDecorator,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(cls.prototype, key);
  if (descriptor === undefined) {
    throw new TypeError(`missing ${key}`);
  }
  decorator(cls.prototype, key, descriptor);
}

async function listen(
  module: Type<unknown>,
): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  const app = await NestFactory.create(module, { logger: false });
  apps.push(app);
  await app.listen(0, "127.0.0.1");
  // SAFETY: NestFactory.create defaults to the Express platform, whose server is a node Server.
  const server = app.getHttpServer() as Server;
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new TypeError("expected tcp address");
  }
  const base = `http://127.0.0.1:${String(address.port)}`;
  return (path, init) => fetch(`${base}${path}`, init);
}

describe("permdock/nest", () => {
  it("sets a request-scoped instance and protects routes", async () => {
    const { PermDockModule, PermDockGuard, Protect, InjectPermDock } =
      createPermDock(policy, {
        subject: () => memberUser,
      });

    class PostsController {
      public remove(permdock: {
        subject: { principal?: { id: string } | null };
      }) {
        return { ok: true, via: permdock.subject.principal?.id };
      }
    }
    Controller()(PostsController);
    applyMethod(PostsController, "remove", Delete("posts/:id"));
    applyMethod(
      PostsController,
      "remove",
      Protect(permissions.post.update, (req) =>
        req.params?.["id"] === "p1" ? ownPost : otherPost,
      ),
    );
    InjectPermDock()(PostsController.prototype, "remove", 0);

    class AppModule {}
    Module({
      imports: [PermDockModule],
      controllers: [PostsController],
      providers: [{ provide: APP_GUARD, useExisting: PermDockGuard }],
    })(AppModule);

    const request = await listen(AppModule);

    const allowed = await request("/posts/p1", { method: "DELETE" });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true, via: "u1" });

    const denied = await request("/posts/p2", { method: "DELETE" });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("answers 401 with a bare Bearer challenge to a caller without credentials", async () => {
    const { PermDockModule, PermDockGuard, Protect } = createPermDock(policy, {
      subject: () => null,
    });

    class PostsController {
      public show() {
        return { ok: true };
      }
    }
    Controller()(PostsController);
    applyMethod(PostsController, "show", Get("posts/:id"));
    applyMethod(
      PostsController,
      "show",
      Protect(permissions.post.read, () => ownPost),
    );

    class AppModule {}
    Module({
      imports: [PermDockModule],
      controllers: [PostsController],
      providers: [{ provide: APP_GUARD, useExisting: PermDockGuard }],
    })(AppModule);

    const request = await listen(AppModule);
    const denied = await request("/posts/p1");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("mounts the AuthZEN evaluations handler", async () => {
    const { PermDockModule, permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
    });

    class AppModule {}
    Module({
      imports: [PermDockModule],
      controllers: [permdockHandler()],
    })(AppModule);

    const request = await listen(AppModule);
    const response = await request("/api/permdock", {
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
    });
    // SAFETY: AuthZEN response JSON produced by permdockHandler under test.
    const body = (await response.json()) as {
      readonly evaluations: readonly { readonly decision: boolean }[];
    };
    expect(body.evaluations[0]?.decision).toBe(true);
  });
});
