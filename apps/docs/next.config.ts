import type { NextConfig } from 'next';

import { createMDX } from 'fumadocs-mdx/next';

import { createNextConfig } from '@permdock/next-config';

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

export default withMDX(config);
