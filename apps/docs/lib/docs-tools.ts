import { findPage, searchDocs, type DocsPageSummary } from "./docs-pages";
import { getLLMText, source } from "./source";

export type DocsTools = {
  readonly search: (query: string, limit: number) => readonly DocsPageSummary[];
  readonly getPage: (path: string) => Promise<string | null>;
};

function pages(): readonly DocsPageSummary[] {
  return source.getPages().map((page) => ({
    title: page.data.title,
    description: page.data.description ?? "",
    url: page.url,
    slugs: page.slugs,
  }));
}

/** Page search and fetch over the docs source, for the Ask AI tools. */
export function docsTools(): DocsTools {
  const catalog = pages();
  return {
    search: (query, limit) => searchDocs(catalog, query, limit),
    getPage: async (path) => {
      const summary = findPage(catalog, path);
      if (summary === null) {
        return null;
      }
      const page = source.getPage([...summary.slugs]);
      if (!page) {
        return null;
      }
      return getLLMText(page);
    },
  };
}
