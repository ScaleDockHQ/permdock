import type { Subject } from "permdock";

import { approvalsHandler } from "permdock/approvals";

import { app, approval, approve, callContext } from "./agent.ts";
import { ownPost } from "./permissions.ts";
import { userById } from "./policy.ts";

/** Demo bearer tokens; a deployed app takes the approver from its own session. */
const BEARERS: Readonly<Record<string, string>> = {
  "Bearer member": "u1",
  "Bearer reviewer": "u2",
};

function subjectOf(request: Request): Subject | null {
  const user = userById(BEARERS[request.headers.get("authorization") ?? ""]);
  return user === null
    ? null
    : { principal: { id: user.id, roles: user.roles }, context: {} };
}

const approvals = approvalsHandler(app.store, { subject: subjectOf });

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const session = url.searchParams.get("session") ?? "s1";
  const call = url.searchParams.get("call") ?? "c1";
  if (request.method === "GET" && path === "/health") {
    return json({ ok: true });
  }
  if (request.method === "GET" && path === "/list_posts") {
    const result = await approval.request(
      callContext(session, call, "list_posts", {}),
    );
    return json({ result });
  }
  if (request.method === "GET" && path === "/delete_post") {
    const result = await approval.request(
      callContext(session, call, "delete_post", { id: ownPost.id }),
    );
    return json(app.inbox === null ? { result } : { result, inbox: app.inbox });
  }
  if (request.method === "POST" && path === "/approve") {
    return json({ result: await approve(session, call, "delete_post") });
  }
  if (request.method === "POST" && path === "/webhooks/permdock") {
    return app.webhook === null
      ? json({ error: "not found" }, 404)
      : app.webhook(request);
  }
  if (path === "/approvals" || path.startsWith("/approvals/")) {
    return approvals(request);
  }
  return json({ error: "not found" }, 404);
}
