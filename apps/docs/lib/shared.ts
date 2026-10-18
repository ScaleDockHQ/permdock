export const appName = "PermDock";
export const docsRoute = "/docs";
// The generated `Route` union has `/docs/${string}` but not a bare `/docs`; a `UrlObject` is untyped.
export const docsIndex = { pathname: docsRoute } as const;
export const chatRoute = `${docsRoute}/api/chat`;
export const docsImageRoute = "/og/docs";
export const docsContentRoute = "/llms.mdx/docs";

/** Docs text changes only on deploy; browsers and the CDN keep it an hour and serve stale for a day. */
export const publicCacheControl =
  "public, max-age=3600, stale-while-revalidate=86400";

export const markdownHeaders = {
  "Content-Type": "text/markdown; charset=utf-8",
  "Cache-Control": publicCacheControl,
} as const;

/** Marketing pages and the changelog, which live outside the docs page tree. */
export const siteLinks = [
  {
    title: "Home",
    path: "/",
    description: "What PermDock is, in one page.",
  },
  {
    title: "Create",
    path: "/create",
    description:
      "Preset builder: pick an archetype, features and a stack; get one install command.",
  },
  {
    title: "Compare",
    path: "/compare",
    description:
      "PermDock next to CASL, Kilpi, permix, Better Auth access control and hosted PDPs.",
  },
  {
    title: "Cloud",
    path: "/cloud",
    description:
      "Optional decision log, hosted AuthZEN ADS and approval inbox; never on the decision path.",
  },
  {
    title: "Enterprise",
    path: "/enterprise",
    description:
      "Fail-closed defaults, signed evidence, SCIM and self-hosting.",
  },
  {
    title: "Pricing",
    path: "/pricing",
    description: "The MIT package is free; Cloud tiers are not announced.",
  },
  {
    title: "Changelog",
    path: `${docsRoute}/changelog`,
    description: "Every release of permdock.",
  },
] as const;

export const gitConfig = {
  user: "ScaleDockHQ",
  repo: "PermDock",
  branch: "main",
  contentDir: "apps/docs/content/docs",
} as const;
