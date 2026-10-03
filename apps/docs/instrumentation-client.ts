import { captureRouterTransitionStart, init } from "@sentry/nextjs";
import { initBotId } from "botid/client/core";

import { sentryOptions } from "@/lib/monitoring";
import { chatRoute } from "@/lib/shared";

init(sentryOptions());
initBotId({ protect: [{ path: chatRoute, method: "POST" }] });

export const onRouterTransitionStart = captureRouterTransitionStart;
