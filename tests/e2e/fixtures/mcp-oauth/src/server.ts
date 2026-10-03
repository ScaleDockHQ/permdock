import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  verifyBearerToken,
} from "@modelcontextprotocol/server";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { handleSaasRoute } from "@permdock/e2e-saas-kit";

import { ORIGIN, PORT, RESOURCE } from "./config.ts";
import { createMcpServer } from "./mcp.ts";
import { metadata, tokenEndpoint, verifier } from "./oauth.ts";

const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
  new URL(RESOURCE),
);
const mcp = createMcpHandler(() => createMcpServer());

async function route(request: Request): Promise<Response> {
  const discovery = oauthMetadataResponse(request, metadata);
  if (discovery !== undefined) {
    return discovery;
  }
  const path = new URL(request.url).pathname;
  if (path === "/oauth/token" && request.method === "POST") {
    return tokenEndpoint(request);
  }
  if (path === "/mcp") {
    try {
      const authInfo = await verifyBearerToken(
        request.headers.get("authorization"),
        {
          verifier,
          resourceMetadataUrl,
        },
      );
      return await mcp.fetch(request, { authInfo });
    } catch (error) {
      return bearerAuthChallengeResponse(error, { resourceMetadataUrl });
    }
  }
  return (
    (await handleSaasRoute(request)) ?? new Response(null, { status: 404 })
  );
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) {
        headers.append(key, item);
      }
    }
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    // SAFETY: an IncomingMessage without setEncoding yields Buffer chunks
    chunks.push(chunk as Buffer);
  }
  return new Request(new URL(req.url ?? "/", ORIGIN), {
    method: req.method ?? "GET",
    headers,
    ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
  });
}

async function send(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  for (const [key, value] of response.headers) {
    if (key !== "set-cookie") {
      res.setHeader(key, value);
    }
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    res.setHeader("set-cookie", cookies);
  }
  if (response.body === null) {
    res.end();
    return;
  }
  for await (const chunk of response.body) {
    res.write(chunk);
  }
  res.end();
}

createServer((req, res) => {
  toRequest(req)
    .then(route)
    .then((response) => send(response, res))
    .catch(() => {
      res.statusCode = 500;
      res.end();
    });
}).listen(PORT, "127.0.0.1");
