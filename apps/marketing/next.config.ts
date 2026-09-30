import type { NextConfig } from 'next';

import { createMDX } from 'fumadocs-mdx/next';

import { createNextConfig } from '@permdock/next-config';

const withMDX = createMDX();

const docsOrigin = process.env['DOCS_ORIGIN'] ?? 'http://127.0.0.1:3001';

const config: NextConfig = {
  ...createNextConfig(),
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
    if (process.env.NODE_ENV === 'production') {
      return [];
    }
    return [
      { source: '/docs', destination: `${docsOrigin}/docs` },
      { source: '/docs/:path*', destination: `${docsOrigin}/docs/:path*` },
      { source: '/api/search', destination: `${docsOrigin}/api/search` },
      { source: '/mcp', destination: `${docsOrigin}/mcp` },
      { source: '/devtools', destination: `${docsOrigin}/devtools` },
      { source: '/llms.txt', destination: `${docsOrigin}/llms.txt` },
      { source: '/llms-full.txt', destination: `${docsOrigin}/llms-full.txt` },
      {
        source: '/llms.mdx/:path*',
        destination: `${docsOrigin}/llms.mdx/:path*`,
      },
      { source: '/og/:path*', destination: `${docsOrigin}/og/:path*` },
    ];
  },
};

export default withMDX(config);
