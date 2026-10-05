import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  verifyBearerToken,
} from "@modelcontextprotocol/server";
import { createServer, type IncomingMessage } from "node:http";
import { resolveApproval } from "permdock/approvals";

import { createProcedureServer } from "./procedures.ts";
import {
  createServer as createMcpServer,
  store,
  userFor,
  verifier,
} from "./server.ts";

const port = Number(process.env["PORT"] ?? 3478);
const host = "127.0.0.1";

const mcp = createMcpHandler(() => createMcpServer({ requireAuthInfo: true }));
const rpc = createMcpHandler(() => createProcedureServer(userFor));

async function toRequest(req: IncomingMessage): Promise<Request> {
  const url = new URL(req.url ?? "/", `http://${host}:${String(port)}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    }
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    // SAFETY: an IncomingMessage without setEncoding yields Buffer chunks
    chunks.push(chunk as Buffer);
  }
  return new Request(url, {
    method: req.method ?? "GET",
    headers,
    ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
  });
}

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
  if (path === "/mcp" || path === "/rpc/mcp") {
    let authInfo;
    try {
      authInfo = await verifyBearerToken(request.headers.get("authorization"), {
        verifier,
      });
    } catch (error) {
      return bearerAuthChallengeResponse(error);
    }
    return (path === "/mcp" ? mcp : rpc).fetch(request, { authInfo });
  }
  // Stands in for the reviewer UI: a real app authenticates the reviewer
  // and checks they may approve before resolving.
  if (request.method === "POST" && path === "/approvals") {
    const body: unknown = await request.json();
    const token =
      body !== null && typeof body === "object" && "token" in body
        ? body.token
        : null;
    if (typeof token !== "string") {
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
    const response = await route(await toRequest(req));
    res.statusCode = response.status;
    for (const [key, value] of response.headers.entries()) {
      res.setHeader(key, value);
    }
    res.end(Buffer.from(await response.arrayBuffer()));
  };
  handle().catch(() => {
    res.statusCode = 500;
    res.end();
  });
}).listen(port, host);
