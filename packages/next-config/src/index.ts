import type { NextConfig } from "next";

/** Hosts `next dev` accepts besides its own: Portless `*.localhost` names and 127.0.0.1. */
const allowedDevOrigins = ["127.0.0.1", "localhost", "**.localhost"];

/**
 * Document security headers for every page. No nonce CSP: it forces dynamic
 * rendering and breaks the prerendered shells. HSTS stays on the Vercel default.
 */
const documentSecurityHeaders = [
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

export type CreateNextConfigOptions = {
  /** `NODE_ENV` from the app's `env.ts`; production builds drop `console` calls except `error` and `warn`. */
  readonly nodeEnv: "development" | "test" | "production";
  /** `EXPOSE_TESTING_API` from the app's `env.ts`: exposes the `instant()` testing API in a production build. */
  readonly exposeTestingApi: boolean;
};

export function createNextConfig(options: CreateNextConfigOptions): NextConfig {
  return {
    reactCompiler: true,
    typedRoutes: true,
    reactStrictMode: true,
    poweredByHeader: false,
    cacheComponents: true,
    partialPrefetching: true,
    allowedDevOrigins,
    compiler: {
      removeConsole:
        options.nodeEnv === "production"
          ? { exclude: ["error", "warn"] }
          : false,
    },
    headers() {
      return Promise.resolve([
        { source: "/(.*)", headers: documentSecurityHeaders },
      ]);
    },
    experimental: {
      useOffline: true,
      globalNotFound: true,
      requestInsights: true,
      authInterrupts: true,
      typedEnv: true,
      turbopackRustReactCompiler: true,
      serverComponentsHmrCancellation: true,
      exposeTestingApiInProductionBuild: options.exposeTestingApi,
      // GitHub runners start without `.next/cache`, and the persistent cache has hung parallel builds there.
      turbopackFileSystemCacheForBuild:
        process.env["GITHUB_ACTIONS"] !== "true",
    },
    typescript: { ignoreBuildErrors: true },
  };
}

export type SentryBuildEnv = {
  readonly VERCEL_ENV?: "development" | "preview" | "production" | undefined;
  readonly SENTRY_ORG?: string | undefined;
  readonly SENTRY_PROJECT?: string | undefined;
  readonly SENTRY_AUTH_TOKEN?: string | undefined;
};

/** `withSentryConfig` build options from the app's `env.ts`: source maps upload only from Vercel production builds. */
export function sentryBuildOptions(env: SentryBuildEnv): {
  readonly org?: string;
  readonly project?: string;
  readonly authToken?: string;
  readonly silent: boolean;
  readonly telemetry: false;
  readonly sourcemaps: { readonly disable: boolean };
  readonly release: { readonly create: boolean };
} {
  const upload = env.VERCEL_ENV === "production";
  return {
    ...(env.SENTRY_ORG === undefined ? {} : { org: env.SENTRY_ORG }),
    ...(env.SENTRY_PROJECT === undefined
      ? {}
      : { project: env.SENTRY_PROJECT }),
    ...(env.SENTRY_AUTH_TOKEN === undefined
      ? {}
      : { authToken: env.SENTRY_AUTH_TOKEN }),
    silent: process.env["CI"] === undefined,
    telemetry: false,
    sourcemaps: { disable: !upload },
    release: { create: upload },
  };
}
