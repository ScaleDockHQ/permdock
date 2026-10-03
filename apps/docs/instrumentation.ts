import { OpenTelemetry } from "@ai-sdk/otel";
import * as Sentry from "@sentry/nextjs";
import { registerTelemetry } from "ai";

import { sentryOptions } from "@/lib/monitoring";

export function register(): void {
  Sentry.init(sentryOptions());
  registerTelemetry(new OpenTelemetry());
}

export const onRequestError = Sentry.captureRequestError;
