import type { FaqItem } from "@/lib/faq";

import { site } from "@/lib/site";

export type JsonLdNode = Readonly<Record<string, unknown>>;

const organizationId = `${site.url}/#organization`;
const websiteId = `${site.url}/#website`;

export function organization(): JsonLdNode {
  return {
    "@type": "Organization",
    "@id": organizationId,
    name: site.name,
    url: site.url,
    logo: `${site.url}/icon`,
    email: site.email,
    sameAs: [site.github, site.npm],
  };
}

export function website(): JsonLdNode {
  return {
    "@type": "WebSite",
    "@id": websiteId,
    name: site.name,
    url: site.url,
    description: site.tagline,
    inLanguage: "en",
    publisher: { "@id": organizationId },
  };
}

export function sourceCode(version?: string): JsonLdNode {
  return {
    "@type": "SoftwareSourceCode",
    name: "permdock",
    description: site.tagline,
    codeRepository: site.github,
    programmingLanguage: "TypeScript",
    runtimePlatform: "Node.js",
    license: "https://opensource.org/license/mit",
    url: site.url,
    ...(version === undefined ? {} : { version }),
    author: { "@id": organizationId },
  };
}

export function faqPage(items: readonly FaqItem[]): JsonLdNode {
  return {
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
}

export function breadcrumbs(
  trail: readonly { readonly name: string; readonly path: string }[],
): JsonLdNode {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [{ name: site.name, path: "" }, ...trail].map(
      (crumb, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: crumb.name,
        item: `${site.url}${crumb.path}`,
      }),
    ),
  };
}

export function graph(nodes: readonly JsonLdNode[]): JsonLdNode {
  return { "@context": "https://schema.org", "@graph": nodes };
}
