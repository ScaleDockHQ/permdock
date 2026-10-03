import type { SQL } from "drizzle-orm";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { toWhere } from "permdock/drizzle";

import {
  findOrg,
  handleSaasRoute,
  membershipsOf,
  readSession,
  saasPermDock,
} from "@permdock/e2e-saas-kit";
import { permissions as p } from "@permdock/e2e-turbo-permissions";

import { archive, db, findRow, projects, reseed } from "./db.ts";
import {
  type Job,
  claim,
  enqueue,
  findJob,
  resetJobs,
  settle,
} from "./jobs.ts";

const PORT = Number(process.env["PORT"] ?? 3509);
const WORKER_TOKEN = process.env["WORKER_TOKEN"] ?? "";

if (WORKER_TOKEN.length < 16) {
  throw new Error("WORKER_TOKEN must be set for the worker routes");
}

let paused = false;

const internal = new Hono()
  .use(async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${WORKER_TOKEN}`) {
      return c.body(null, 401);
    }
    return next();
  })
  .post("/jobs/claim", (c) => {
    const job = paused ? undefined : claim();
    return job === undefined ? c.body(null, 204) : c.json(job);
  })
  .get("/jobs/:id/input", async (c) => {
    const job = findJob(c.req.param("id"));
    if (job === undefined) {
      return c.body(null, 404);
    }
    const org = findOrg(job.org);
    return c.json({
      row: (await findRow(job.projectId)) ?? null,
      memberships: membershipsOf(job.onBehalfOf),
      plans: org === undefined ? [] : [org.plan],
      customRoles: org?.customRoles ?? [],
    });
  })
  .post("/jobs/:id/settle", async (c) => {
    const job = findJob(c.req.param("id"));
    const result: { outcome?: unknown; reason?: unknown } = await c.req.json();
    if (job?.status !== "running") {
      return c.body(null, 409);
    }
    if (result.outcome === "granted") {
      await archive(job.projectId);
      settle(job, "done");
    } else {
      settle(
        job,
        "denied",
        typeof result.reason === "string" ? result.reason : "denied",
      );
    }
    return c.body(null, 204);
  });

function view(job: Job) {
  return { id: job.id, status: job.status, reason: job.reason ?? null };
}

const app = new Hono()
  .get("/api/health", (c) => c.json({ ok: true }))
  .post("/api/test/reset", async (c) => {
    const response = await handleSaasRoute(c.req.raw);
    await reseed();
    resetJobs();
    paused = false;
    return response ?? c.notFound();
  })
  .post("/api/test/worker", async (c) => {
    const input: { paused?: unknown } = await c.req.json();
    paused = input.paused === true;
    return c.json({ paused });
  })
  .route("/internal", internal)
  .get("/:org/projects", async (c) => {
    const session = await readSession(c.req.header("cookie"));
    if (session === null) {
      return c.body(null, 401);
    }
    const permdock = await saasPermDock(session, c.req.param("org"));
    if (!permdock.can(p.project.list)) {
      return c.body(null, 403);
    }
    // SAFETY: toWhere compiles against the Drizzle `projects` table, so it returns a Drizzle SQL
    const rows = await db
      .select()
      .from(projects)
      .where(toWhere(permdock.where(p.project.read), projects) as SQL)
      .orderBy(projects.id);
    return c.json({ projects: rows });
  })
  .post("/:org/projects/:id/archive", async (c) => {
    const session = await readSession(c.req.header("cookie"));
    if (session === null) {
      return c.body(null, 401);
    }
    const org = c.req.param("org");
    const permdock = await saasPermDock(session, org);
    const row = await findRow(c.req.param("id"));
    if (row === undefined || !permdock.can(p.project.update, row)) {
      return c.body(null, 403);
    }
    const job = enqueue({ org, projectId: row.id, onBehalfOf: session.sub });
    return c.json(view(job), 202);
  })
  .get("/jobs/:id", async (c) => {
    const session = await readSession(c.req.header("cookie"));
    const job = findJob(c.req.param("id"));
    if (session === null || job?.onBehalfOf !== session.sub) {
      return c.body(null, 404);
    }
    return c.json(view(job));
  })
  .all("*", async (c) => (await handleSaasRoute(c.req.raw)) ?? c.notFound());

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" });
