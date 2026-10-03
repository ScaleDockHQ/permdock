import { env } from "@/env";

/** Sentry reports only from production builds that have a DSN; local dev and tests stay silent. */
export function sentryOptions(): {
  readonly dsn: string | undefined;
  readonly enabled: boolean;
  readonly environment: string;
  readonly tracesSampleRate: number;
  readonly sendDefaultPii: false;
} {
  const dsn = env.NEXT_PUBLIC_SENTRY_DSN;
  return {
    dsn,
    enabled: dsn !== undefined && env.NODE_ENV === "production",
    environment: env.NEXT_PUBLIC_VERCEL_ENV ?? env.NODE_ENV,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  };
}
