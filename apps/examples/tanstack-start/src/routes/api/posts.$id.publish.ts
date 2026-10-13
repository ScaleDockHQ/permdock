import { createFileRoute } from "@tanstack/react-router";

import { postFromPath, protect } from "../../lib/permdock.ts";
import { permissions } from "../../lib/permissions.ts";

export const Route = createFileRoute("/api/posts/$id/publish")({
  server: {
    middleware: [protect(permissions.post.publish, postFromPath)],
    handlers: { POST: () => Response.json({ ok: true }) },
  },
});
