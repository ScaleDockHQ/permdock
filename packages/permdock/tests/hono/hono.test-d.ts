import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { describe, expectTypeOf, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";
import type { PermDockEnv } from "../../src/hono/index.ts";
import type { PermDockOf } from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/hono/index.ts";
import { ownPost, permissions, policy } from "../fixtures/quick-start.ts";

type QuickStartPermDock = PermDockOf<typeof policy>;

const { permdock, protect } = createPermDock(policy, {
  subject: () => null,
});

describe("permdock/hono Env typing", () => {
  it("types c.get(permdock) without an app Env generic", () => {
    new Hono().use(permdock()).get("/", (c) => {
      expectTypeOf(c.get("permdock")).toEqualTypeOf<QuickStartPermDock>();
      return c.body(null);
    });
  });

  it("types permdockData from the protect loader", () => {
    new Hono().get(
      "/posts/:id",
      protect(permissions.post.update, async () =>
        Math.random() > 0.5 ? ownPost : null,
      ),
      (c) => {
        expectTypeOf(c.get("permdockData")).toEqualTypeOf<typeof ownPost>();
        expectTypeOf(c.get("permdock")).toEqualTypeOf<QuickStartPermDock>();
        return c.body(null);
      },
    );
  });

  it("merges with an app Env", () => {
    new Hono<{ Variables: { user: string } }>()
      .use(permdock())
      .get("/", (c) => {
        expectTypeOf(c.get("user")).toEqualTypeOf<string>();
        expectTypeOf(c.get("permdock")).toEqualTypeOf<QuickStartPermDock>();
        return c.body(null);
      });
  });

  it("types c.get(permdock) inside createMiddleware with PermDockEnv", () => {
    const audit = createMiddleware<PermDockEnv>(async (c, next) => {
      expectTypeOf(c.get("permdock")).toEqualTypeOf<PermDock>();
      await next();
    });
    new Hono()
      .use(permdock())
      .use(audit)
      .get("/", (c) => {
        expectTypeOf(c.get("permdock")).toExtend<QuickStartPermDock>();
        return c.body(null);
      });
  });
});
