import { describe, expect, it } from "vitest";

import {
  findPage,
  normalizeDocsPath,
  searchDocs,
  type DocsPageSummary,
} from "../lib/docs-pages";

const pages: readonly DocsPageSummary[] = [
  {
    title: "Hono",
    description: "Fetch kernel adapter for Hono",
    url: "/docs/adapters/hono",
    slugs: ["adapters", "hono"],
  },
  {
    title: "Extension interfaces",
    description: "LimitStore and exhausted quotas",
    url: "/docs/concepts/extension-interfaces",
    slugs: ["concepts", "extension-interfaces"],
  },
  {
    title: "Naming",
    description: "Public identifiers",
    url: "/docs/getting-started/naming",
    slugs: ["getting-started", "naming"],
  },
];

describe("searchDocs", () => {
  it("ranks title matches above path matches", () => {
    const hits = searchDocs(pages, "hono");
    expect(hits[0]?.url).toBe("/docs/adapters/hono");
  });

  it("returns nothing for an empty query", () => {
    expect(searchDocs(pages, "   ")).toEqual([]);
  });

  it("caps the limit", () => {
    expect(searchDocs(pages, "adapter", 1)).toHaveLength(1);
  });
});

describe("normalizeDocsPath", () => {
  it("strips /docs, hosts and suffixes", () => {
    expect(normalizeDocsPath("/docs/adapters/hono")).toEqual([
      "adapters",
      "hono",
    ]);
    expect(
      normalizeDocsPath("https://permdock.dev/docs/adapters/hono.md"),
    ).toEqual(["adapters", "hono"]);
    expect(normalizeDocsPath("llms.mdx/docs/adapters/hono")).toEqual([
      "adapters",
      "hono",
    ]);
  });
});

describe("findPage", () => {
  it("resolves a slug path", () => {
    expect(findPage(pages, "adapters/hono")?.title).toBe("Hono");
  });

  it("returns null for an unknown path", () => {
    expect(findPage(pages, "adapters/missing")).toBeNull();
  });
});
