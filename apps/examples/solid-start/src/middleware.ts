import { createMiddleware } from "@solidjs/start/middleware";

import { middleware } from "./lib/permdock.ts";

export default createMiddleware([middleware()]);
