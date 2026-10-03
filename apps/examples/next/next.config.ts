import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    authInterrupts: true,
    useOffline: true,
    // `@next/playwright` instant() against `next start`; only the e2e build sets it.
    exposeTestingApiInProductionBuild: process.env["NEXT_E2E"] === "1",
  },
};

export default config;
