import type { NextConfig } from 'next';

import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

const config: NextConfig = {
  reactStrictMode: true,
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
