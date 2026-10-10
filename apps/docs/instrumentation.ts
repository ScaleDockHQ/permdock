import { OpenTelemetry } from "@ai-sdk/otel";
import * as Sentry from "@sentry/nextjs";
import { registerTelemetry } from "ai";

import { sentryOptions } from "@/lib/monitoring";

export function register(): void {
  // Sentry's tracer creates a scope per Next.js span, and the scope's
  // `crypto.randomUUID()` aborts the request-time prerender of a slug outside
  // `generateStaticParams`, so an unknown docs URL answers 500 instead of 404.
  Sentry.init({ ...sentryOptions(), enableOpenTelemetrySetup: false });
  registerTelemetry(new OpenTelemetry());
}

export const onRequestError = Sentry.captureRequestError;
