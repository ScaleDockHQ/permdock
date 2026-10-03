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
    ];
  },
  rewrites() {
    return {
      beforeFiles: [
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
