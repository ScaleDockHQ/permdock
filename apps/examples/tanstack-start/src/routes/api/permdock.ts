import { createFileRoute } from "@tanstack/react-router";

import { permdockHandler } from "../../lib/permdock.ts";

export const Route = createFileRoute("/api/permdock")({
  server: { handlers: permdockHandler() },
});
