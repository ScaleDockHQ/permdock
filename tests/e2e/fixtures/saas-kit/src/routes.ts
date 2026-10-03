import { saasPermissions } from "permdock/testing/saas";

import type { Session } from "./session.ts";

import {
  clearedCookie,
  isUser,
  mintSession,
  readSession,
  saasPermDock,
  sessionCookie,
} from "./session.ts";
import {
  changedAt,
  findProject,
  removeProject,
  resetStore,
  setPlan,
  setRole,
} from "./store.ts";

function json(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  if (cookie !== undefined) {
    headers.set("set-cookie", cookie);
  }
  return new Response(null, { status: 303, headers });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const value: unknown = await request.json();
    // SAFETY: checked to be a non-null object; every value stays unknown
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  }
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Deletes a project after a fresh server-side check; the UI never decides. */
export async function deleteProject(
  session: Session | null,
  id: string,
): Promise<{ readonly ok: boolean; readonly reason?: string }> {
  const project = findProject(id);
  if (project === undefined) {
    return { ok: false, reason: "not-found" };
  }
  const permdock = await saasPermDock(session, project.orgId);
  const decision = permdock.decide(saasPermissions.project.delete, project);
  if (decision.outcome !== "granted") {
    return {
      ok: false,
      reason:
        decision.outcome === "denied"
          ? (decision.denials[0]?.reason ?? "denied")
          : decision.reason,
    };
  }
  removeProject(id);
  return { ok: true };
}

type PostRoute = (request: Request) => Promise<Response>;

const postRoutes: Readonly<Record<string, PostRoute>> = {
  "/api/test/reset": () => {
    resetStore();
    return Promise.resolve(json({ ok: true }));
  },
  "/api/test/set-role": async (request) => {
    const input = await readBody(request);
    const ok = setRole(
      text(input["org"]),
      text(input["user"]),
      text(input["role"]),
    );
    return json({ ok }, ok ? 200 : 404);
  },
  "/api/test/billing": async (request) => {
    const input = await readBody(request);
    const ok = setPlan(
      text(input["org"]),
      input["plan"] === "pro" ? "pro" : "free",
    );
    return json({ ok }, ok ? 200 : 404);
  },
  "/api/login": async (request) => {
    const input = await readBody(request);
    if (!isUser(input["user"])) {
      return redirect("/login");
    }
    return redirect("/acme", sessionCookie(await mintSession(input["user"])));
  },
  "/api/logout": () => Promise.resolve(redirect("/login", clearedCookie)),
};

/**
 * Test and session routes shared by every fixture, as a Fetch handler.
 * Returns `undefined` for paths it does not own.
 */
export async function handleSaasRoute(
  request: Request,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname;
  const post = request.method === "POST";
  if (path === "/api/health") {
    return json({ ok: true });
  }
  const route =
    post && Object.hasOwn(postRoutes, path) ? postRoutes[path] : undefined;
  if (route !== undefined) {
    return route(request);
  }
  const session = await readSession(request.headers.get("cookie"));
  if (request.method === "GET" && path === "/api/version") {
    const org = url.searchParams.get("org") ?? "";
    const keys = [
      `org:${org}`,
      ...(session === null ? [] : [`user:${session.sub}`]),
    ];
    return json({ changedAt: changedAt(keys) });
  }
  const remove = /^\/api\/projects\/([^/]+)\/delete$/u.exec(path);
  if (post && remove?.[1] !== undefined) {
    const result = await deleteProject(session, remove[1]);
    return json(result, result.ok ? 200 : 403);
  }
  return undefined;
}
