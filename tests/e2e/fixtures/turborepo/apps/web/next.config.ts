import type { NextConfig } from 'next';

import { createPermDockPlugin } from '@permdock/cli/plugin';

const drift = process.env.PERMDOCK_E2E_DRIFT === '1';

const config: NextConfig = {
  reactStrictMode: true,
  // The drift build must not overwrite the build the server is running.
  distDir: drift ? '.next-drift' : '.next',
};

export default createPermDockPlugin()(config);
