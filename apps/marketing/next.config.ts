import type { NextConfig } from 'next';

import { withSentryConfig } from '@sentry/nextjs/config';
import { createMDX } from 'fumadocs-mdx/next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

import { createNextConfig, sentryBuildOptions } from '@permdock/next-config';

import { env } from './env.ts';

const withMDX = createMDX();

export default function nextConfig(phase: string): NextConfig {
  const docsOrigin = env.DOCS_ORIGIN;
  return withSentryConfig(
    withMDX({
      ...createNextConfig(),
      transpilePackages: ['@permdock/ui'],
      redirects() {
        return [
          {
            source: '/problems/:type',
            destination: '/docs/standards/problem-details#:type',
            permanent: true,
          },
        ];
      },
      rewrites() {
        if (phase !== PHASE_DEVELOPMENT_SERVER) {
          return [];
        }
        return [
          { source: '/docs', destination: `${docsOrigin}/docs` },
          { source: '/docs/:path*', destination: `${docsOrigin}/docs/:path*` },
          { source: '/api/search', destination: `${docsOrigin}/api/search` },
          { source: '/mcp', destination: `${docsOrigin}/mcp` },
          { source: '/devtools', destination: `${docsOrigin}/devtools` },
          { source: '/llms.txt', destination: `${docsOrigin}/llms.txt` },
          {
            source: '/llms-full.txt',
            destination: `${docsOrigin}/llms-full.txt`,
          },
          {
            source: '/llms.mdx/:path*',
            destination: `${docsOrigin}/llms.mdx/:path*`,
          },
          { source: '/og/:path*', destination: `${docsOrigin}/og/:path*` },
        ];
      },
    }),
    sentryBuildOptions(),
  );
}
