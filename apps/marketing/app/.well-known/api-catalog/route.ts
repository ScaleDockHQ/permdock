import { site } from "@/lib/site";

const CATALOG = `${site.url}/.well-known/api-catalog`;

/**
 * RFC 9727 fixes the media type and asks for the `api-catalog` link on HEAD
 * too.
 */
const HEADERS = {
  "content-type":
    'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
  link: `<${CATALOG}>; rel="api-catalog"`,
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=3600",
};

const linkset = {
  linkset: [
    { anchor: CATALOG, item: [{ href: site.cloud.api }] },
    {
      anchor: site.cloud.api,
      "service-desc": [
        {
          href: `${site.cloud.api}/openapi.json`,
          type: "application/vnd.oai.openapi+json",
        },
      ],
      "service-doc": [
        { href: `${site.url}/docs/adapters/cloud`, type: "text/html" },
      ],
    },
  ],
};

export function GET(): Response {
  return new Response(JSON.stringify(linkset), { headers: HEADERS });
}

export function HEAD(): Response {
  return new Response(null, { headers: HEADERS });
}
