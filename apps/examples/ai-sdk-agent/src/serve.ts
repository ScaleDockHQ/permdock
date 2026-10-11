import { createServer } from "node:http";
import { sendResponse, toRequest } from "permdock/node";

import { toolApproval } from "./agent.ts";
import { ownPost } from "./permissions.ts";

const port = Number(process.env["PORT"] ?? 3472);
const host = "127.0.0.1";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function route(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/health") {
    return json({ ok: true });
  }
  if (request.method === "GET" && path === "/list_posts") {
    const result = await toolApproval({
      toolCall: { toolName: "list_posts", input: {} },
    });
    return json({ result });
  }
  if (request.method === "GET" && path === "/delete_post") {
    const result = await toolApproval({
      toolCall: { toolName: "delete_post", input: { id: ownPost.id } },
    });
    return json({ result });
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
