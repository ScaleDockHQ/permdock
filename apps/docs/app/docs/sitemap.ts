import type { MetadataRoute } from 'next';

import { env } from '@/env';
import { source } from '@/lib/source';

export default function sitemap(): MetadataRoute.Sitemap {
  return source.getPages().map((page) => {
    const entry: MetadataRoute.Sitemap[number] = {
      url: `${env.NEXT_PUBLIC_SITE_URL}${page.url}`,
    };
    if (page.data.lastModified) {
      entry.lastModified = page.data.lastModified;
    }
    return entry;
  });
}
