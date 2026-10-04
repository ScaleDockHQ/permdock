import { createEnv } from "@t3-oss/env-nextjs";
import { vercel } from "@t3-oss/env-nextjs/presets-valibot";
import * as v from "valibot";

const url = v.pipe(v.string(), v.url());

export const env = createEnv({
  extends: [vercel()],
  shared: {
    NODE_ENV: v.optional(
      v.picklist(["development", "test", "production"]),
      "development",
    ),
  },
  client: {
    NEXT_PUBLIC_SITE_URL: v.optional(url, "https://permdock.com"),
    NEXT_PUBLIC_SENTRY_DSN: v.optional(url),
    NEXT_PUBLIC_VERCEL_ENV: v.optional(
      v.picklist(["development", "preview", "production"]),
    ),
  },
  experimental__runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_SITE_URL: process.env["NEXT_PUBLIC_SITE_URL"],
    NEXT_PUBLIC_SENTRY_DSN: process.env["NEXT_PUBLIC_SENTRY_DSN"],
    NEXT_PUBLIC_VERCEL_ENV: process.env["NEXT_PUBLIC_VERCEL_ENV"],
  },
  emptyStringAsUndefined: true,
});
