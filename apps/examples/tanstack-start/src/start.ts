import { createStart } from "@tanstack/react-start";

import { middleware } from "./lib/permdock.ts";

export const startInstance = createStart(() => ({
  requestMiddleware: [middleware()],
}));
