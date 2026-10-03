import type { MetadataRoute } from "next";

import { env } from "@/env";
import { changelogRoute } from "@/lib/changelog";
import { source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  const docs = source.getPages().map((page) => {
    const entry: MetadataRoute.Sitemap[number] = {
      url: `${env.NEXT_PUBLIC_SITE_URL}${page.url}`,
    };
    if (page.data.lastModified) {
      entry.lastModified = page.data.lastModified;
    }
    return entry;
  });
  return [...docs, { url: `${env.NEXT_PUBLIC_SITE_URL}${changelogRoute}` }];
}
