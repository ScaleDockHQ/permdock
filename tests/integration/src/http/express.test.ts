import type { Request } from "express";

import express from "express";
import multer from "multer";
import { createServer } from "node:http";
import { createPermDock, type PermDockRequest } from "permdock/express";
import { testHttpAdapter } from "permdock/testing";
import { saasPermissions as p } from "permdock/testing/saas";

import { listen } from "../support/listen.ts";

testHttpAdapter({
  name: "permdock/express on node:http",
  async mount(domain) {
    const { permdock, protect, errorHandler, permdockHandler } = createPermDock(
      domain.policy,
      {
        subject: (req) =>
          domain.subject(req.headers.authorization, req.originalUrl),
        // SAFETY: Express types every param as present; `org` is absent on routes without it
        tenant: (req) => req.params["org"] as string | undefined,
        customRoles: domain.customRoles,
        store: domain.store,
        limits: domain.limits,
      },
    );
    // SAFETY: Express types every param as present; `id` is absent on routes without it
    const row = (req: Request) =>
      domain.project(req.params["id"] as string | undefined);
    const upload = multer({ storage: multer.memoryStorage() });

    const admin = express.Router({ mergeParams: true });
    admin.get("/members", protect(p.member.list), (_req, res) => {
      res.json({ members: [] });
    });

    const app = express();
    // Before the body parsers on purpose: the bridge must not drain the stream.
    app.use(permdock());
    app.use(express.json());
    app.use("/:org/permdock/access/v1/evaluations", permdockHandler());
    app.use("/:org/admin", admin);
    app.get("/:org/projects/:id", protect(p.project.read, row), (req, res) => {
      // SAFETY: protect() above sets permdock and permdockData before this handler runs
      res.json((req as PermDockRequest).permdockData);
    });
    app.patch(
      "/:org/projects/:id",
      protect(p.project.update, row),
      (req, res) => {
        res.json({ id: req.params["id"] });
      },
    );
    app.post(
      "/:org/projects",
      // SAFETY: req.body is typed any; protect() validates it against the resource schema
      protect(p.project.create, (req) => req.body as unknown, {
        trusted: false,
      }),
      (req, res) => {
        // SAFETY: protect() above sets permdock and permdockData before this handler runs
        res.status(201).json((req as PermDockRequest).permdockData);
      },
    );
    app.delete(
      "/:org/projects/:id",
      protect(p.project.read, row),
      (req, res) => {
        // SAFETY: protect() above sets permdock and permdockData before this handler runs
        const scoped = req as PermDockRequest;
        scoped.permdock.assert(p.project.delete, scoped.permdockData);
        res.status(204).end();
      },
    );
    app.post(
      "/:org/projects/:id/files",
      protect(p.project.update, row),
      upload.single("file"),
      (req, res) => {
        const file = req.file;
        if (file === undefined) {
          res.status(400).end();
          return;
        }
        res.status(201).json({ name: file.originalname, size: file.size });
      },
    );
    app.get("/:org/analytics", protect(p.analytics.read), (_req, res) => {
      res.json({ ok: true });
    });
    app.post("/:org/api-keys", protect(p.apiKey.create), (_req, res) => {
      res.status(201).json({ ok: true });
    });
    app.post(
      "/:org/api-keys/revoke-all",
      protect(p.apiKey.revokeAll),
      (_req, res) => {
        res.status(204).end();
      },
    );
    app.use(errorHandler());

    return listen(
      createServer((req, res) => {
        app(req, res);
      }),
    );
  },
});
