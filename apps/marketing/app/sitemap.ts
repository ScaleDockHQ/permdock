import type { MetadataRoute } from "next";

import { site } from "@/lib/site";
import { publishedPosts } from "@/lib/source";

const routes = [
  "",
  "/create",
  "/cloud",
  "/pricing",
  "/compare",
  "/enterprise",
  "/blog",
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    ...routes.map((path) => ({ url: `${site.url}${path}` })),
    ...publishedPosts().map((post) => ({ url: `${site.url}${post.url}` })),
  ];
}
