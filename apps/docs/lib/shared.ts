export const appName = 'PermDock';
export const docsRoute = '/docs';
// The generated `Route` union has `/docs/${string}` but not a bare `/docs`; a `UrlObject` is untyped.
export const docsIndex = { pathname: docsRoute } as const;
export const chatRoute = `${docsRoute}/api/chat`;
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

/** Docs text changes only on deploy; browsers and the CDN keep it an hour and serve stale for a day. */
export const publicCacheControl =
  'public, max-age=3600, stale-while-revalidate=86400';

export const markdownHeaders = {
  'Content-Type': 'text/markdown; charset=utf-8',
  'Cache-Control': publicCacheControl,
} as const;

export const gitConfig = {
  user: 'ScaleDockHQ',
  repo: 'PermDock',
  branch: 'main',
  contentDir: 'apps/docs/content/docs',
} as const;
