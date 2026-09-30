export const appName = 'PermDock';
export const docsRoute = '/docs';
// The generated `Route` union has `/docs/${string}` but not a bare `/docs`; a `UrlObject` is untyped.
export const docsIndex = { pathname: docsRoute } as const;
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

export const gitConfig = {
  user: 'ScaleDockHQ',
  repo: 'PermDock',
  branch: 'main',
  contentDir: 'apps/docs/content/docs',
} as const;
