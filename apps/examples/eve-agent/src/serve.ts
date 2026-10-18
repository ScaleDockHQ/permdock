import { createServer } from "node:http";
import { sendResponse, toRequest } from "permdock/node";

import { app } from "./agent.ts";
import { route } from "./app.ts";

const port = Number(process.env["PORT"] ?? 3474);
const host = "127.0.0.1";

const hosted = app.policies;
if (hosted !== null) {
  await hosted.refresh();
  setInterval(() => {
    hosted.refresh().catch(() => null);
  }, 60_000).unref();
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
