import { readFileSync } from "node:fs";
import { join } from "node:path";
type VercelJson = {
  readonly rewrites: readonly {
    readonly source: string;
    readonly destination: string | { readonly service: string };
  }[];
};

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
  return [
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
