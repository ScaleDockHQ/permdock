import type { NextConfig } from "next";

import { createPermDockPlugin } from "permdock/next/plugin";

const config: NextConfig = {
  reactStrictMode: true,
  reactCompiler: true,
  typedRoutes: true,
  allowedDevOrigins: ["127.0.0.1"],
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: ["pg"],
  headers() {
    const tools = [{ key: "Permissions-Policy", value: "tools=*" }];
    return [
      { source: "/:locale/:orgSlug/quotes", headers: tools },
      { source: "/:locale/:orgSlug/quotes/:id", headers: tools },
    ];
  },
  experimental: {
    authInterrupts: true,
    // Retries navigation, prefetch and Server Action requests after the browser reconnects.
    useOffline: true,
    // `permdock/next` taints the PermDock instance and options so they cannot reach a client component.
    taint: true,
    turbopackRustReactCompiler: true,
    // Pinned: the framework default may change between minors.
    instantInsights: { validationLevel: "warning" },
    // Read at `next build`; only the `test:e2e` build sets it.
    exposeTestingApiInProductionBuild:
      process.env["EXPOSE_TESTING_API"] === "1",
  },
};

export default createPermDockPlugin()(config);
