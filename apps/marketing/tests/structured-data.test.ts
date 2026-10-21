import { describe, expect, test } from "vitest";

import { faqItems } from "../lib/faq";
import { site } from "../lib/site";
import {
  breadcrumbs,
  faqPage,
  graph,
  sourceCode,
} from "../lib/structured-data";

describe("structured data", () => {
  test("breadcrumbs start at the home page and number from 1", () => {
    expect(breadcrumbs([{ name: "Create", path: "/create" }])).toStrictEqual({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: site.name, item: site.url },
        {
          "@type": "ListItem",
          position: 2,
          name: "Create",
          item: `${site.url}/create`,
        },
      ],
    });
  });

  test("the FAQ page carries every visible question", () => {
    const node = faqPage(faqItems);
    expect(node["mainEntity"]).toHaveLength(faqItems.length);
  });

  test("source code omits the version when no release is known", () => {
    expect(sourceCode()).not.toHaveProperty("version");
    expect(sourceCode("1.2.0")).toHaveProperty("version", "1.2.0");
  });

  test("the graph declares the schema.org context", () => {
    expect(graph([])).toStrictEqual({
      "@context": "https://schema.org",
      "@graph": [],
    });
  });
});
