import type { NextConfig } from "next";

import { withSentryConfig } from "@sentry/nextjs/config";
import { withBotId } from "botid/next/config";
import { createMDX } from "fumadocs-mdx/next";

import { createNextConfig, sentryBuildOptions } from "@permdock/next-config";

import { docsContentRoute } from "./lib/shared";

const withMDX = createMDX();

// A markdown type listed before any `text/html`: agents ask for markdown first,
// browsers always lead with `text/html`.
const markdownAccept = {
  type: "header",
  key: "accept",
  value: "(?:(?!text/html).)*text/(?:x-)?markdown.*",
} as const;

// Research pages retired in the 0.1.0 reset, mapped to the page that owns the topic now.
const retiredResearch = {
  "agent-frameworks": "/docs/research/ecosystem-index",
  "agent-standards-2026": "/docs/standards/agent-docs-standards",
  "api-surface-2026": "/docs/research/landscape",
  "casl-v7": "/docs/research/landscape",
  "commercial-landscape": "/docs/research/landscape",
  "expo-router": "/docs/adapters/react-native",
  "kilpi-v1": "/docs/research/landscape",
  "local-first-sync": "/docs/research/ecosystem-index",
  "next-intl-extraction-model": "/docs/research/landscape",
  "nextjs-16-3-instant-navigation": "/docs/guides/next-cache-components",
  "openapi-ecosystem": "/docs/research/ecosystem-index",
  "permix-lessons": "/docs/research/landscape",
  "postgres-rls": "/docs/standards/postgres-rls",
  "saas-tenancy-and-roles": "/docs/concepts/tenancy",
  "zap-studio-permit": "/docs/research/landscape",
} as const;

const config: NextConfig = {
  ...createNextConfig({
    headers: [
      { source: "/docs/:path*", headers: [{ key: "Vary", value: "Accept" }] },
    ],
  }),
  assetPrefix: "/docs",
  transpilePackages: ["@permdock/ui"],
  redirects() {
    return [
      {
        source: "/",
        destination: "/docs",
        permanent: false,
      },
      ...Object.entries(retiredResearch).flatMap(([slug, destination]) =>
        ["/", "%2F"].map((separator) => ({
          source: `/docs/research${separator}${slug}`,
          destination,
          permanent: true,
        })),
      ),
    ];
  },
  rewrites() {
    return {
      beforeFiles: [
        { source: "/docs/llms.txt", destination: "/llms.txt" },
        { source: "/docs/llms-full.txt", destination: "/llms-full.txt" },
        { source: "/docs.md", destination: `${docsContentRoute}/content.md` },
        {
          source: "/docs/:path+.md",
          destination: `${docsContentRoute}/:path+/content.md`,
        },
        {
          source: "/docs",
          has: [markdownAccept],
          destination: `${docsContentRoute}/content.md`,
        },
        {
          source: "/docs/:path((?!_next/|api/).+)",
          has: [markdownAccept],
          destination: `${docsContentRoute}/:path/content.md`,
        },
      ],
      afterFiles: [
        {
          source: "/docs/_next/:path*",
          destination: "/_next/:path*",
        },
      ],
      fallback: [],
    };
  },
};

export default withSentryConfig(
  withBotId(withMDX(config)),
  sentryBuildOptions(),
);
