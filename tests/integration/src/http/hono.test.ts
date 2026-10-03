import type { Server } from "node:http";
import type { PermDock } from "permdock";

import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createPermDock } from "permdock/hono";
import { testHttpAdapter } from "permdock/testing";
import { saasPermissions as p } from "permdock/testing/saas";

import { listen } from "../support/listen.ts";

type Env = {
  Variables: { permdock: PermDock; permdockData: unknown };
};

testHttpAdapter({
  name: "permdock/hono on @hono/node-server",
  streams: true,
  async mount(domain) {
    const { permdock, protect, connection, sse, permdockHandler } =
      createPermDock(domain.policy, {
        revocations: domain.revocations,
        subject: (c) =>
          domain.session(c.req.header("authorization"), c.req.path),
        tenant: (c) => c.req.param("org"),
        customRoles: domain.customRoles,
        store: domain.store,
        limits: domain.limits,
      });
    const row = (c: { req: { param: (key: string) => string | undefined } }) =>
      domain.project(c.req.param("id"));

    const admin = new Hono<Env>().get("/members", protect(p.member.list), (c) =>
      c.json({ members: [] }),
    );

    const app = new Hono<Env>()
      .use(permdock())
      .route("/:org/permdock/access/v1/evaluations", permdockHandler())
      .route("/:org/admin", admin)
      .get(
        "/:org/projects/:id/events",
        protect(p.project.read, row),
        async (c) => {
          const conn = await connection(c, {
            permission: p.project.read,
            data: c.get("permdockData"),
          });
          return streamSSE(c, async (stream) => {
            await sse(
              conn,
              stream,
              domain.ticks(domain.org(c.req.path), conn.signal),
              { items: p.project.update },
            );
          });
        },
      )
      .get("/:org/projects/:id", protect(p.project.read, row), (c) =>
        c.json(c.get("permdockData")),
      )
      .patch("/:org/projects/:id", protect(p.project.update, row), (c) =>
        c.json({ id: c.req.param("id") }),
      )
      .post(
        "/:org/projects",
        protect(p.project.create, (c) => c.req.json(), { trusted: false }),
        (c) => c.json(c.get("permdockData"), 201),
      )
      .delete("/:org/projects/:id", protect(p.project.read, row), (c) => {
        c.get("permdock").assert(p.project.delete, c.get("permdockData"));
        return c.body(null, 204);
      })
      .post(
        "/:org/projects/:id/files",
        protect(p.project.update, row),
        async (c) => {
          const form = await c.req.parseBody();
          const file = form["file"];
          if (!(file instanceof File)) {
            return c.body(null, 400);
          }
          return c.json({ name: file.name, size: file.size }, 201);
        },
      )
      .get("/:org/analytics", protect(p.analytics.read), (c) =>
        c.json({ ok: true }),
      )
      .post("/:org/api-keys", protect(p.apiKey.create), (c) =>
        c.json({ ok: true }, 201),
      )
      .post("/:org/api-keys/revoke-all", protect(p.apiKey.revokeAll), (c) =>
        c.body(null, 204),
      );

    // SAFETY: createAdaptorServer without http2 options creates a node:http Server
    return listen(createAdaptorServer({ fetch: app.fetch }) as Server);
  },
});
