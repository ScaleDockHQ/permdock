import {
  findPage,
  searchDocs,
  type DocsMcpTools,
  type DocsPageSummary,
} from './docs-mcp';
import { getLLMText, source } from './source';

function pages(): readonly DocsPageSummary[] {
  return source.getPages().map((page) => ({
    title: page.data.title,
    description: page.data.description ?? '',
    url: page.url,
    slugs: page.slugs,
  }));
}

/** Page search and fetch over the docs source, shared by `/mcp` and Ask AI. */
export function docsTools(): DocsMcpTools {
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
