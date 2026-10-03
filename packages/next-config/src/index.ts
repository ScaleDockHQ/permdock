import type { NextConfig } from "next";

/** Hosts `next dev` accepts besides its own: Portless `*.localhost` names and 127.0.0.1. */
export const allowedDevOrigins: readonly string[] = [
  "127.0.0.1",
  "localhost",
  "**.localhost",
];

/**
 * Document security headers for every page. No nonce CSP: it forces dynamic
 * rendering and breaks the prerendered shells. HSTS stays on the Vercel default.
 */
export const documentSecurityHeaders: readonly {
  readonly key: string;
  readonly value: string;
}[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'self'; base-uri 'none'",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), display-capture=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
];

export type NextConfigHeaderRule = {
  readonly source: string;
  readonly headers: readonly { readonly key: string; readonly value: string }[];
};

export type CreateNextConfigOptions = {
  /** Barrel packages to tree-shake beyond the Next.js defaults. */
  readonly optimizePackageImports?: readonly string[];
  /** Header rules added after the document security headers. */
  readonly headers?: readonly NextConfigHeaderRule[];
};

export function createNextConfig(
  options: CreateNextConfigOptions = {},
): NextConfig {
  return {
    reactCompiler: true,
    typedRoutes: true,
    reactStrictMode: true,
    poweredByHeader: false,
    cacheComponents: true,
    partialPrefetching: true,
    cacheLife: {
      reference: { stale: 900, revalidate: 900, expire: 86_400 },
    },
    allowedDevOrigins: [...allowedDevOrigins],
    headers() {
      return Promise.resolve([
        { source: "/(.*)", headers: [...documentSecurityHeaders] },
        ...(options.headers ?? []).map((rule) => ({
          source: rule.source,
          headers: [...rule.headers],
        })),
      ]);
    },
    experimental: {
      globalNotFound: true,
      requestInsights: true,
      typedEnv: true,
      turbopackRustReactCompiler: true,
      // GitHub runners start without `.next/cache`, and the persistent cache has hung parallel builds there.
      turbopackFileSystemCacheForBuild:
        process.env["GITHUB_ACTIONS"] !== "true",
      optimizePackageImports: [...(options.optimizePackageImports ?? [])],
      // `@next/playwright` `instant()` locks; never set on a real production deploy.
      exposeTestingApiInProductionBuild:
        process.env["EXPOSE_TESTING_API"] === "1",
    },
    typescript: { ignoreBuildErrors: true },
  };
}

/** `withSentryConfig` build options: source maps upload only from Vercel production builds. */
export function sentryBuildOptions(): {
  readonly org?: string;
  readonly project?: string;
  readonly authToken?: string;
  readonly silent: boolean;
  readonly telemetry: false;
  readonly sourcemaps: { readonly disable: boolean };
  readonly release: { readonly create: boolean };
} {
  const upload = process.env["VERCEL_ENV"] === "production";
  const org = process.env["SENTRY_ORG"];
  const project = process.env["SENTRY_PROJECT"];
  const authToken = process.env["SENTRY_AUTH_TOKEN"];
  return {
    ...(org === undefined ? {} : { org }),
    ...(project === undefined ? {} : { project }),
    ...(authToken === undefined ? {} : { authToken }),
    silent: process.env["CI"] === undefined,
    telemetry: false,
    sourcemaps: { disable: !upload },
    release: { create: upload },
  };
}
