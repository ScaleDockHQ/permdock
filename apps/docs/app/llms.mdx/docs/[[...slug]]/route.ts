import { cacheLife } from 'next/cache';
import { notFound } from 'next/navigation';

import { markdownHeaders } from '@/lib/shared';
import { docsLlms, getPageMarkdownUrl, source } from '@/lib/source';

type MarkdownRouteContext = {
  params: Promise<{ slug?: string[] }>;
};

async function pageMarkdown(
  slugs: readonly string[] | undefined,
): Promise<string | null> {
  'use cache';
  cacheLife('max');
  const page = source.getPage(slugs === undefined ? undefined : [...slugs]);
  return page ? docsLlms.page(page) : null;
}

export async function GET(
  _req: Request,
  context: MarkdownRouteContext,
): Promise<Response> {
  const { slug } = await context.params;
  const markdown = await pageMarkdown(slug?.slice(0, -1));
  if (markdown === null) notFound();

  return new Response(markdown, { headers: markdownHeaders });
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    lang: page.locale,
    slug: getPageMarkdownUrl(page).segments,
  }));
}
