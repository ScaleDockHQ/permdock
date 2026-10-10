import type * as PageTree from "fumadocs-core/page-tree";

import { describe, expect, it } from "vitest";

import {
  compactMarkdownTables,
  renderLlmsIndex,
  type LlmsPage,
} from "../lib/llms";

const siteUrl = "https://docs.test";

const pages: Record<string, LlmsPage> = {
  "/docs": {
    title: "PermDock",
    description: "Typed permissions.",
    markdownUrl: `${siteUrl}/docs.md`,
  },
  "/docs/getting-started/quick-start": {
    title: "Quick start",
    description: "Four files.",
    markdownUrl: `${siteUrl}/docs/getting-started/quick-start.md`,
  },
  "/docs/adapters": {
    title: "Adapters",
    description: "One core.",
    markdownUrl: `${siteUrl}/docs/adapters.md`,
  },
  "/docs/adapters/react": {
    title: "React",
    description: "",
    markdownUrl: `${siteUrl}/docs/adapters/react.md`,
  },
  "/docs/research/landscape": {
    title: "Landscape",
    description: "Prior art.",
    markdownUrl: `${siteUrl}/docs/research/landscape.md`,
  },
};

const page = (url: string, name: string): PageTree.Item => ({
  type: "page",
  name,
  url,
});

const tree: PageTree.Root = {
  name: "PermDock",
  children: [
    page("/docs", "PermDock"),
    page("/docs/ask", "Ask AI"),
    { type: "separator", name: "Start" },
    {
      type: "folder",
      name: "Getting started",
      children: [page("/docs/getting-started/quick-start", "Quick start")],
    },
    { type: "separator", name: "Integrate" },
    {
      type: "folder",
      name: "Adapters",
      index: page("/docs/adapters", "Adapters"),
      children: [
        { type: "separator", name: "UI" },
        page("/docs/adapters/react", "React"),
      ],
    },
    page("/docs/changelog", "Changelog"),
    { type: "separator", name: "Background" },
    {
      type: "folder",
      name: "Research",
      children: [page("/docs/research/landscape", "Landscape")],
    },
  ],
};

const index = renderLlmsIndex(tree, {
  siteUrl,
  optional: ["Background"],
  resolve: (url) => pages[url],
});

describe("renderLlmsIndex", () => {
  it("opens with the H1 and the root page's description as the summary", () => {
    expect(index.startsWith("# PermDock\n\n> Typed permissions.\n")).toBe(true);
  });

  it("points at the full text, the MCP server and the skills", () => {
    expect(index).toContain(`(${siteUrl}/llms-full.txt)`);
    expect(index).toContain(`\`${siteUrl}/mcp\``);
    expect(index).toContain("npx skills add ScaleDockHQ/PermDock");
  });

  it("turns separators into H2 sections and folders into H3", () => {
    const headings = index.split("\n").filter((line) => line.startsWith("#"));
    expect(headings).toEqual([
      "# PermDock",
      "## Start",
      "### Getting started",
      "## Integrate",
      "### Adapters",
      "#### UI",
      "## Optional",
      "### Background",
      "#### Research",
    ]);
  });

  it("links the absolute Markdown URL with the description", () => {
    expect(index).toContain(
      `- [Quick start](${siteUrl}/docs/getting-started/quick-start.md): Four files.`,
    );
    expect(index).toContain(
      `- [Adapters](${siteUrl}/docs/adapters.md): One core.`,
    );
    expect(index).toContain(`- [React](${siteUrl}/docs/adapters/react.md)\n`);
  });

  it("leaves out tree links that are not docs pages", () => {
    expect(index).not.toContain("Ask AI");
    expect(index).not.toContain("Changelog");
  });

  it("puts the optional sections last", () => {
    expect(index.indexOf("## Optional")).toBeGreaterThan(
      index.indexOf("## Integrate"),
    );
    expect(index.endsWith("Prior art.\n")).toBe(true);
  });
});

describe("compactMarkdownTables", () => {
  it("drops cell padding and shortens delimiter rows", () => {
    const table = [
      "| Name      | Kind          |",
      "| --------- | :-----------: |",
      "| `can`     | method        |",
    ].join("\n");
    expect(compactMarkdownTables(table)).toBe(
      ["| Name | Kind |", "| --- | :---: |", "| `can` | method |"].join("\n"),
    );
  });

  it("keeps escaped pipes inside a cell", () => {
    expect(compactMarkdownTables("| `a \\| b`   | c |")).toBe(
      "| `a \\| b` | c |",
    );
  });

  it("keeps the indentation of a table inside a list item", () => {
    expect(compactMarkdownTables("  | a   | b |")).toBe("  | a | b |");
  });

  it("leaves fenced code untouched", () => {
    const fenced = [
      "```md",
      "| a     | b |",
      "```",
      "",
      "~~~~",
      "```",
      "| c     | d |",
      "~~~~",
    ].join("\n");
    expect(compactMarkdownTables(fenced)).toBe(fenced);
  });

  it("leaves prose with pipes alone", () => {
    const prose = "Use `a | b` here,   with spacing.";
    expect(compactMarkdownTables(prose)).toBe(prose);
  });
});
