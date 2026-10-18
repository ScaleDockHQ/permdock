import type { NextConfig } from "next";

import { withSentryConfig } from "@sentry/nextjs/config";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

import { createNextConfig, sentryBuildOptions } from "@permdock/next-config";

import { env } from "./env.ts";

export default function nextConfig(phase: string): NextConfig {
  const docsOrigin = env.DOCS_ORIGIN;
  return withSentryConfig(
    {
      ...createNextConfig({
        nodeEnv: env.NODE_ENV,
        exposeTestingApi: env.EXPOSE_TESTING_API === "1",
      }),
      transpilePackages: ["@permdock/ui"],
      redirects() {
        return [
          {
            source: "/changelog",
            destination: "/docs/changelog",
            permanent: true,
          },
          {
            source: "/blog/:path*",
            destination: "/docs/changelog",
            permanent: true,
          },
          {
            source: "/problems/:type",
            destination: "/docs/standards/problem-details#:type",
            permanent: true,
          },
        ];
      },
      rewrites() {
        if (phase !== PHASE_DEVELOPMENT_SERVER) {
          return [];
        }
        // The `docs` service rewrites in vercel.json, for `next dev`; `pnpm docs:drift` keeps both in step.
        return [
          { source: "/docs", destination: `${docsOrigin}/docs` },
          { source: "/docs/:path*", destination: `${docsOrigin}/docs/:path*` },
          { source: "/docs.md", destination: `${docsOrigin}/docs.md` },
          { source: "/api/search", destination: `${docsOrigin}/api/search` },
          { source: "/devtools", destination: `${docsOrigin}/devtools` },
          { source: "/llms.txt", destination: `${docsOrigin}/llms.txt` },
          {
            source: "/llms-full.txt",
            destination: `${docsOrigin}/llms-full.txt`,
          },
          {
            source: "/llms.mdx/:path*",
            destination: `${docsOrigin}/llms.mdx/:path*`,
          },
          { source: "/og/:path*", destination: `${docsOrigin}/og/:path*` },
          {
            source: "/149e9513-01fa-4fb0-aad4-566afd725d1b/:path*",
            destination: `${docsOrigin}/149e9513-01fa-4fb0-aad4-566afd725d1b/:path*`,
          },
        ];
      },
    },
    sentryBuildOptions(env),
  );
}
