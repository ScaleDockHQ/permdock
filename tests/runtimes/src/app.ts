import type { JsonWebKeySet } from "permdock/jwt";

import { Hono } from "hono";
import { memoryRoleSource } from "permdock";
import { createPermDock as createAuthzen } from "permdock/authzen";
import { createPermDock as createHono } from "permdock/hono";
import { createJwtSubjectResolver } from "permdock/jwt";
import { createPermDock as createKernel } from "permdock/server";
import {
  saasAudience,
  saasCustomRoles,
  saasIssuer,
  saasJwks,
  saasMemberships,
  saasPermissions as p,
  saasPolicy,
  saasPrincipal,
  saasSeed,
} from "permdock/testing/saas";

/** The only bearer the AuthZEN endpoint accepts: a test-only PEP credential. */
export const PEP_TOKEN = "runtimes-pep-bearer";

export const customRoles = memoryRoleSource(saasCustomRoles);

const verify = createJwtSubjectResolver({
  // SAFETY: saasJwks is a well-formed EC JWKS; its EcJwk type differs from JsonWebKeySet's key type
  jwks: saasJwks as unknown as JsonWebKeySet,
  issuer: saasIssuer,
  audience: saasAudience,
});

/**
 * The JWT proves identity only; memberships and plans come from the seed, as
 * a verifying auth layer in front of a real app would load them.
 */
export async function subjectOf(
  authorization: string | null | undefined,
  tenant: string | undefined,
) {
  const token =
    authorization?.startsWith("Bearer ") === true
      ? authorization.slice("Bearer ".length)
      : undefined;
  const id = (await verify(token)).principal?.id;
  return id === undefined
    ? null
    : { principal: saasPrincipal(id, tenant), context: {} };
}

export function projectOf(id: string | undefined) {
  return saasSeed.projects.find((project) => project.id === id) ?? null;
}

const PROJECT_PATH = /^\/kernel\/([^/]+)\/projects\/([^/]+)$/u;

const kernel = createKernel(saasPolicy, {
  subject: (request) =>
    subjectOf(
      request.headers.get("authorization"),
      PROJECT_PATH.exec(new URL(request.url).pathname)?.[1],
    ),
  tenant: (request) => PROJECT_PATH.exec(new URL(request.url).pathname)?.[1],
  customRoles,
});

async function kernelRoute(request: Request): Promise<Response> {
  const id = PROJECT_PATH.exec(new URL(request.url).pathname)?.[2];
  const permission =
    request.method === "PATCH" ? p.project.update : p.project.read;
  const guard = await kernel.protect(permission, () => projectOf(id))(request);
  return guard.ok ? Response.json(guard.data) : guard.response;
}

const hono = createHono(saasPolicy, {
  subject: (c) => subjectOf(c.req.header("authorization"), c.req.param("org")),
  tenant: (c) => c.req.param("org"),
  customRoles,
});
const row = (c: { req: { param: (key: string) => string | undefined } }) =>
  projectOf(c.req.param("id"));

const authzen = createAuthzen(saasPolicy, {
  subject: (request) =>
    request.headers.get("authorization") === `Bearer ${PEP_TOKEN}`
      ? { principal: { id: "pep" }, context: {} }
      : null,
  trustedPep: (pep) =>
    // SAFETY: `principal` and `id` are optional; optional chaining covers null
    (pep as { principal?: { id?: string } } | null)?.principal?.id === "pep",
  resources: { project: { load: (id) => projectOf(id) } },
  memberships: {
    membershipsFor: (principal) => saasMemberships(principal.id),
  },
  customRoles,
});

export const app = new Hono()
  .get("/health", (c) => c.json({ ok: true }))
  .on(["GET", "PATCH"], "/kernel/:org/projects/:id", (c) =>
    kernelRoute(c.req.raw),
  )
  .use("/hono/:org/*", hono.permdock())
  .get("/hono/:org/projects/:id", hono.protect(p.project.read, row), (c) =>
    c.json(projectOf(c.req.param("id"))),
  )
  .patch("/hono/:org/projects/:id", hono.protect(p.project.update, row), (c) =>
    c.json({ id: c.req.param("id") }),
  )
  .all("/access/v1/*", (c) => authzen.permdockHandler(c.req.raw));
