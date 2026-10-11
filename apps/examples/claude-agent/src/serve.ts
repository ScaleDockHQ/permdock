import { createServer } from "node:http";
import { resolveApproval } from "permdock/approvals";
import { sendResponse, toRequest } from "permdock/node";

import { canUseTool, store } from "./agent.ts";
import { ownPost } from "./permissions.ts";

const port = Number(process.env["PORT"] ?? 3473);
const host = "127.0.0.1";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/health") {
    return json({ ok: true });
  }
  if (request.method === "GET" && path === "/list_posts") {
    const result = await canUseTool("list_posts", {});
    return json({ result });
  }
  if (request.method === "GET" && path === "/delete_post") {
    const result = await canUseTool("delete_post", { id: ownPost.id });
    return json({ result });
  }
  // Stands in for the reviewer UI: a real app authenticates the reviewer
  // and checks they may approve before resolving.
  if (request.method === "POST" && path === "/approvals") {
    const token = url.searchParams.get("token");
    if (token === null) {
      return json({ error: "token required" }, 400);
    }
    await resolveApproval(store, token, {
      status: "approved",
      by: { principal: { id: "u2", roles: ["admin"] }, context: {} },
    });
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

createServer((req, res) => {
  const handle = async (): Promise<void> => {
    try {
      const response = await route(toRequest(req));
      await sendResponse(res, response);
    } catch {
      res.statusCode = 500;
      res.end();
    }
  };
  handle().catch(() => {
    res.statusCode = 500;
    res.end();
  });
}).listen(port, host);
