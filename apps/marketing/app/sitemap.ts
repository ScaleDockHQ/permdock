import type { MetadataRoute } from "next";

import { site } from "@/lib/site";

const routes = [
  "",
  "/cloud",
  "/pricing",
  "/compare",
  "/enterprise",
  "/blog",
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return routes.map((path) => ({ url: `${site.url}${path}` }));
}
