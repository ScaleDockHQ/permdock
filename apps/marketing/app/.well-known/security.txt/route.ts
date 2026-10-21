import { cacheLife } from "next/cache";
import { Temporal } from "temporal-polyfill";

import { site } from "@/lib/site";

/**
 * RFC 9116 recommends an `Expires` less than a year ahead; the daily cache
 * keeps it moving.
 */
const EXPIRES_IN = Temporal.Duration.from({ hours: 180 * 24 });

async function securityTxt(): Promise<string> {
  "use cache";
  cacheLife("days");
  const expires = Temporal.Now.instant()
    .add(EXPIRES_IN)
    .round({ smallestUnit: "second", roundingMode: "floor" });
  return [
    `Contact: ${site.github}/security/advisories/new`,
    `Expires: ${expires.toString()}`,
    `Policy: ${site.github}/security/policy`,
    "Preferred-Languages: en",
    `Canonical: ${site.url}/.well-known/security.txt`,
    "",
  ].join("\n");
}

export async function GET(): Promise<Response> {
  return new Response(await securityTxt(), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
