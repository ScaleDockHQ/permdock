import * as Sentry from "@sentry/nextjs";

import { sentryOptions } from "@/lib/monitoring";

export function register(): void {
  Sentry.init(sentryOptions());
}

export const onRequestError = Sentry.captureRequestError;
