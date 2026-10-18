import { serve } from "@hono/node-server";

import { env } from "./env.ts";
import { cloudPolicy } from "./policy-cloud.ts";
import { createPdp } from "./server.ts";

if (env.project === null) {
  throw new Error(
    "set PERMDOCK_CLOUD_PROJECT and PERMDOCK_CLOUD_TOKEN to serve the project's hosted policy",
  );
}

const { permdockHandler } = createPdp(await cloudPolicy(env.project));
const pdp = permdockHandler();

serve({
  fetch: (request): Response | Promise<Response> =>
    request.method === "GET" && new URL(request.url).pathname === "/health"
      ? Response.json({ ok: true })
      : pdp(request),
  port: Number(process.env["PORT"] ?? 3470),
  hostname: "127.0.0.1",
});
