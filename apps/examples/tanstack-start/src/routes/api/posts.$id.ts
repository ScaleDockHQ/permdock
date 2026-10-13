import { createFileRoute } from "@tanstack/react-router";

import { postFromPath, protect } from "../../lib/permdock.ts";
import { permissions } from "../../lib/permissions.ts";

export const Route = createFileRoute("/api/posts/$id")({
  server: {
    middleware: [protect(permissions.post.update, postFromPath)],
    handlers: {
      PATCH: ({ context }) =>
        Response.json({ ok: true, id: context.permdockData.id }),
    },
  },
});
