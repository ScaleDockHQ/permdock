import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    exposeTestingApiInProductionBuild: process.env['NEXT_E2E'] === '1',
  },
};

export default config;
