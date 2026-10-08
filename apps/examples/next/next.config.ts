import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  reactCompiler: true,
  allowedDevOrigins: ["127.0.0.1"],
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    authInterrupts: true,
    useOffline: true,
    turbopackRustReactCompiler: true,
    // Pinned: the framework default may change between minors.
    instantInsights: { validationLevel: "warning" },
    // Read at `next build`; only the `test:instant` build sets it.
    exposeTestingApiInProductionBuild:
      process.env["EXPOSE_TESTING_API"] === "1",
  },
};

export default config;
