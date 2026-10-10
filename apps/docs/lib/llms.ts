import type * as PageTree from "fumadocs-core/page-tree";
import type { ReactNode } from "react";

export type LlmsPage = {
  readonly title: string;
  readonly description: string;
  /** Absolute URL of the page's Markdown. */
  readonly markdownUrl: string;
};

export type LlmsIndexOptions = {
  readonly siteUrl: string;
  /** The docs page behind a tree URL; links to anything else are left out. */
  readonly resolve: (url: string) => LlmsPage | undefined;
  /** Separator names emitted as the llms.txt `## Optional` section. */
  readonly optional?: readonly string[];
};

type Section = { readonly name: string; readonly nodes: PageTree.Node[] };

function textOf(node: ReactNode): string {
  return typeof node === "string" || typeof node === "number"
    ? String(node)
    : "";
}

function pageLine(item: PageTree.Item, options: LlmsIndexOptions): string[] {
  const page = options.resolve(item.url);
  if (page === undefined) return [];
  const description = page.description === "" ? "" : `: ${page.description}`;
  return [`- [${page.title}](${page.markdownUrl})${description}`];
}

function renderNodes(
  nodes: readonly PageTree.Node[],
  depth: number,
  options: LlmsIndexOptions,
): string[] {
  const heading = "#".repeat(Math.min(depth, 6));
  const lines: string[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "page":
        lines.push(...pageLine(node, options));
        break;
      case "separator": {
        const name = textOf(node.name);
        if (name !== "") lines.push("", `${heading} ${name}`, "");
        break;
      }
      case "folder": {
        const children = [
          ...(node.index ? pageLine(node.index, options) : []),
          ...renderNodes(node.children, depth + 1, options),
        ];
        if (children.length > 0) {
          lines.push("", `${heading} ${textOf(node.name)}`, "", ...children);
        }
        break;
      }
      default: {
        const unreachable: never = node;
        return unreachable;
      }
    }
  }
  return lines;
}

function sectionsOf(tree: PageTree.Root): {
  readonly lead: PageTree.Node[];
  readonly sections: Section[];
} {
  const lead: PageTree.Node[] = [];
  const sections: Section[] = [];
  for (const node of tree.children) {
    if (node.type === "separator") {
      sections.push({ name: textOf(node.name), nodes: [] });
    } else {
      (sections.at(-1)?.nodes ?? lead).push(node);
    }
  }
  return { lead, sections };
}

/** Collapses blank-line runs and trims the blank lines a heading leaves at either end. */
function tidy(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line === "" && (out.length === 0 || out.at(-1) === "")) continue;
    out.push(line);
  }
  while (out.at(-1) === "") out.pop();
  return out;
}

/** `llms.txt` per llmstxt.org: an H1, a summary quote, then one H2 list of links per section. */
export function renderLlmsIndex(
  tree: PageTree.Root,
  options: LlmsIndexOptions,
): string {
  const optional = new Set(options.optional ?? []);
  const { lead, sections } = sectionsOf(tree);
  const leadPages = lead.flatMap((node) =>
    node.type === "page" ? [options.resolve(node.url)] : [],
  );
  const summary = leadPages.find((page) => page !== undefined)?.description;

  const lines = [
    `# ${textOf(tree.name)}`,
    "",
    ...(summary === undefined || summary === "" ? [] : [`> ${summary}`, ""]),
    "Every link below is the page as Markdown; append `.md` to any docs URL for the same.",
    "",
    `- [Full text](${options.siteUrl}/llms-full.txt): every page in one file`,
    `- Docs MCP server: \`${options.siteUrl}/mcp\` with the \`search\`, \`list_pages\` and \`get_page\` tools`,
    "- Agent Skills: `npx skills add ScaleDockHQ/PermDock`",
    ...renderNodes(lead, 3, options),
  ];
  const optionalLines: string[] = [];
  for (const section of sections) {
    const isOptional = optional.has(section.name);
    const body = renderNodes(section.nodes, isOptional ? 4 : 3, options);
    if (body.length === 0) continue;
    if (isOptional) {
      optionalLines.push("", `### ${section.name}`, "", ...body);
    } else {
      lines.push("", `## ${section.name}`, "", ...body);
    }
  }
  if (optionalLines.length > 0) lines.push("", "## Optional", ...optionalLines);
  return `${tidy(lines).join("\n")}\n`;
}

const fence = /^\s*(`{3,}|~{3,})/u;
const delimiterRow = /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/u;
const cellPadding = / *(?<!\\)\| */gu;

function compactRow(line: string): string {
  const indent = /^\s*/u.exec(line)?.[0] ?? "";
  const row = line.slice(indent.length).replaceAll(cellPadding, " | ").trim();
  return (
    indent + (delimiterRow.test(row) ? row.replaceAll(/-+/gu, "---") : row)
  );
}

/**
 * Drops the column-alignment padding oxfmt writes into Markdown tables; GFM
 * ignores it, and it is about a third of the docs' bytes. Fenced code is left as is.
 */
export function compactMarkdownTables(markdown: string): string {
  let open: string | undefined;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = fence.exec(line)?.[1];
      if (marker !== undefined) {
        if (open === undefined) open = marker;
        else if (marker.startsWith(open)) open = undefined;
        return line;
      }
      return open === undefined && line.trimStart().startsWith("|")
        ? compactRow(line)
        : line;
    })
    .join("\n");
}
