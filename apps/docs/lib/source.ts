import { llms, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineDocs } from "fumadocs-mdx/macro";

import { env } from "@/env";

import { compactMarkdownTables, renderLlmsIndex } from "./llms";
import { docsContentRoute, docsImageRoute, docsRoute } from "./shared";

const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    lastModified: true,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

export function getPageImageUrl(page: (typeof source)["$inferPage"]) {
  const segments = [...page.slugs, "image.png"];

  return {
    segments,
    url:
      "/" +
      [page.locale, ...docsImageRoute.split("/"), ...segments]
        .filter(Boolean)
        .join("/"),
  };
}

export function getPageMarkdownUrl(page: (typeof source)["$inferPage"]) {
  const segments = [...page.slugs, "content.md"];

  return {
    segments,
    url:
      "/" +
      [page.locale, ...docsContentRoute.split("/"), ...segments]
        .filter(Boolean)
        .join("/"),
  };
}

export async function getLLMText(page: (typeof source)["$inferPage"]) {
  const processed = await page.data.getText("processed");
  const description =
    page.data.description === undefined || page.data.description === ""
      ? ""
      : `\n\n${page.data.description}`;

  return `# ${page.data.title}

Source: ${env.NEXT_PUBLIC_SITE_URL}${page.url}${description}

${compactMarkdownTables(processed.trimStart())}`;
}

/** `llms-full.txt`, the `.md` pages and the MCP `list_pages` and `get_page` tools render through this. */
export const docsLlms = llms(source, { renderPage: getLLMText });

export function renderDocsLlmsIndex(): string {
  const pages = new Map(source.getPages().map((page) => [page.url, page]));
  return renderLlmsIndex(source.getPageTree(), {
    siteUrl: env.NEXT_PUBLIC_SITE_URL,
    optional: ["Background"],
    resolve(url) {
      const page = pages.get(url);
      return page
        ? {
            title: page.data.title,
            description: page.data.description ?? "",
            markdownUrl: `${env.NEXT_PUBLIC_SITE_URL}${page.url}.md`,
          }
        : undefined;
    },
  });
}
