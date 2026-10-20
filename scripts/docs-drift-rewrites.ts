import { readFileSync } from "node:fs";
import { join } from "node:path";
type VercelJson = {
  readonly rewrites: readonly {
    readonly source: string;
    readonly destination: string | { readonly service: string };
  }[];
};

const CLOUD_ORIGIN = "https://app.permdock.com";
const CLOUD_SOURCES = [
  "/api/(.*)",
  "/mcp",
  "/.well-known/oauth-authorization-server/api",
  "/.well-known/oauth-protected-resource/mcp",
];

/** Vercel path syntax and the Next.js `:path*` form name the same match. */
function normalise(source: string): string {
  return source.replace(/:path\*$/u, "(.*)");
}

/** Paths vercel.json sends to the `docs` service that the marketing dev rewrites miss, and the reverse. */
export function rewriteDrift(root: string): readonly string[] {
  // SAFETY: vercel.json is the repository's own config, checked by its `$schema`
  const vercel = JSON.parse(
    readFileSync(join(root, "vercel.json"), "utf8"),
  ) as VercelJson;
  const deployed = new Set(
    vercel.rewrites
      .filter(
        (rule) =>
          typeof rule.destination !== "string" &&
          rule.destination.service === "docs",
      )
      .map((rule) => normalise(rule.source)),
  );
  const config = readFileSync(
    join(root, "apps", "marketing", "next.config.ts"),
    "utf8",
  );
  const local = new Set<string>();
  for (const [, source = ""] of config.matchAll(
    /source: "([^"]+)",\s*destination: `\$\{docsOrigin\}/gu,
  )) {
    local.add(normalise(source));
  }
  const order = vercel.rewrites.map((rule) => rule.source);
  const before = (first: string, later: string): boolean =>
    order.indexOf(first) !== -1 &&
    order.indexOf(later) !== -1 &&
    order.indexOf(first) < order.indexOf(later);
  const cloud = vercel.rewrites.filter(
    (rule) =>
      typeof rule.destination === "string" &&
      rule.destination.startsWith(CLOUD_ORIGIN),
  );
  const misordered = [
    ...(before("/api/search", "/api/(.*)")
      ? []
      : [
          "vercel.json must route /api/search to docs before /api/(.*) goes to the Cloud",
        ]),
    ...cloud
      .filter((rule) => !before(rule.source, "/(.*)"))
      .map(
        (rule) =>
          `vercel.json routes ${rule.source} to the Cloud after the /(.*) catch-all, which shadows it`,
      ),
    ...(cloud.length === CLOUD_SOURCES.length &&
    CLOUD_SOURCES.every((source) =>
      cloud.some((rule) => rule.source === source),
    )
      ? []
      : [
          `vercel.json must route ${CLOUD_SOURCES.join(", ")} to ${CLOUD_ORIGIN}`,
        ]),
  ];
  return [
    ...misordered,
    ...[...deployed]
      .filter((source) => !local.has(source))
      .map(
        (source) =>
          `vercel.json sends ${source} to docs; apps/marketing/next.config.ts has no dev rewrite for it`,
      ),
    ...[...local]
      .filter((source) => !deployed.has(source))
      .map(
        (source) =>
          `apps/marketing/next.config.ts rewrites ${source} to docs in dev; vercel.json does not`,
      ),
  ];
}
