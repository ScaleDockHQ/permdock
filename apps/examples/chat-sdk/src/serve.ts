import { createServer } from "node:http";
import { sendResponse, toRequest } from "permdock/node";

import { chat } from "./bot.ts";

const port = Number(process.env["PORT"] ?? 3498);
const host = "127.0.0.1";

async function route(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path === "/api/webhooks/slack") {
    const response = await chat.webhooks.slack(request);
    return response;
  }
  return new Response(null, { status: 404 });
}

createServer((req, res) => {
  const respond = async (): Promise<void> => {
    await sendResponse(res, await route(toRequest(req)));
  };
  respond().catch(() => {
    res.statusCode = 500;
    res.end();
  });
}).listen(port, host);
