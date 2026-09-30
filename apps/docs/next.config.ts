import type { NextConfig } from 'next';

import { withSentryConfig } from '@sentry/nextjs/config';
import { createMDX } from 'fumadocs-mdx/next';

import { createNextConfig, sentryBuildOptions } from '@permdock/next-config';

const withMDX = createMDX();

const config: NextConfig = {
  ...createNextConfig(),
  assetPrefix: '/docs',
  redirects() {
    return [
      {
        source: '/',
        destination: '/docs',
        permanent: false,
      },
    ];
  },
  rewrites() {
    return [
      {
        source: '/docs/_next/:path*',
        destination: '/_next/:path*',
      },
    ];
  },
};

export default withSentryConfig(withMDX(config), sentryBuildOptions());
