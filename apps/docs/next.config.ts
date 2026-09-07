import type { NextConfig } from 'next';

import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

const config: NextConfig = {
  reactStrictMode: true,
  redirects() {
    return [
      {
        source: '/',
        destination: '/docs',
        permanent: false,
      },
    ];
  },
};

export default withMDX(config);
