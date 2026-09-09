export type DocsPageSummary = {
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly slugs: readonly string[];
};

export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 25;

function tokensOf(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((part) => part.length > 0);
}

function scorePage(
  page: DocsPageSummary,
  queryTokens: readonly string[],
): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  const title = tokensOf(page.title);
  const description = tokensOf(page.description);
  const path = tokensOf(page.slugs.join(' '));
  let score = 0;
  for (const token of queryTokens) {
    if (title.includes(token)) {
      score += 3;
    }
    if (description.includes(token)) {
      score += 2;
    }
    if (path.includes(token)) {
      score += 1;
    }
  }
  return score;
}

export function searchDocs(
  pages: readonly DocsPageSummary[],
  query: string,
  limit = DEFAULT_SEARCH_LIMIT,
): readonly DocsPageSummary[] {
  const queryTokens = tokensOf(query);
  const capped =
    Number.isInteger(limit) && limit > 0
      ? Math.min(limit, MAX_SEARCH_LIMIT)
      : DEFAULT_SEARCH_LIMIT;
  return pages
    .map((page) => ({ page, score: scorePage(page, queryTokens) }))
    .filter((entry) => entry.score > 0)
    .toSorted(
      (a, b) => b.score - a.score || a.page.url.localeCompare(b.page.url),
    )
    .slice(0, capped)
    .map((entry) => entry.page);
}

export function normalizeDocsPath(path: string): readonly string[] {
  const trimmed = path.trim();
  const withoutHost = trimmed.replace(/^https?:\/\/[^/]+/u, '');
  const withoutHash = withoutHost.split('#')[0] ?? withoutHost;
  const withoutQuery = withoutHash.split('?')[0] ?? withoutHash;
  const withoutSuffix = withoutQuery
    .replace(/\/+$/u, '')
    .replace(/\.(md|mdx)$/u, '');
  const parts = withoutSuffix.split('/').filter((part) => part.length > 0);
  if (parts[0] === 'docs') {
    return parts.slice(1);
  }
  if (parts[0] === 'llms.mdx' && parts[1] === 'docs') {
    return parts.slice(2);
  }
  return parts;
}

export function findPage(
  pages: readonly DocsPageSummary[],
  path: string,
): DocsPageSummary | null {
  const slugs = normalizeDocsPath(path);
  const key = slugs.join('/');
  return pages.find((page) => page.slugs.join('/') === key) ?? null;
}
