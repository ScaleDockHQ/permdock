import { getBreadcrumbItems } from "fumadocs-core/breadcrumb";

import { env } from "@/env";

import { appName, docsRoute } from "./shared";
import { getPageImageUrl, source } from "./source";

type DocsPage = NonNullable<ReturnType<typeof source.getPage>>;

/**
 * The `@id`s the marketing home page declares; docs pages reference them
 * instead of repeating them.
 */
const organizationId = `${env.NEXT_PUBLIC_SITE_URL}/#organization`;
const websiteId = `${env.NEXT_PUBLIC_SITE_URL}/#website`;

function absolute(path: string): string {
  return `${env.NEXT_PUBLIC_SITE_URL}${path}`;
}

function breadcrumbList(page: DocsPage) {
  const trail = getBreadcrumbItems(page.url, source.getPageTree()).flatMap(
    (item) =>
      typeof item.name === "string" && item.url !== undefined
        ? [{ name: item.name, url: item.url }]
        : [],
  );
  const crumbs = [
    { name: appName, url: "" },
    ...(page.url === docsRoute ? [] : [{ name: "Docs", url: docsRoute }]),
    ...trail.filter((item) => item.url !== docsRoute && item.url !== page.url),
    { name: page.data.title, url: page.url },
  ];
  return {
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: absolute(crumb.url),
    })),
  };
}

export function docsPageJsonLd(
  page: DocsPage,
): Readonly<Record<string, unknown>> {
  const modified = page.data.lastModified;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        headline: page.data.title,
        ...(page.data.description === undefined
          ? {}
          : { description: page.data.description }),
        url: absolute(page.url),
        image: absolute(getPageImageUrl(page).url),
        inLanguage: "en",
        ...(modified === undefined
          ? {}
          : { dateModified: modified.toISOString() }),
        isPartOf: { "@id": websiteId },
        publisher: { "@id": organizationId },
      },
      breadcrumbList(page),
    ],
  };
}
