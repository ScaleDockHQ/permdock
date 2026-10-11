import { cacheLife } from "next/cache";
import { notFound } from "next/navigation";

import { markdownHeaders } from "@/lib/shared";
import { docsLlms, getPageMarkdownUrl, source } from "@/lib/source";

type MarkdownRouteContext = {
  params: Promise<{ slug?: string[] }>;
};

async function pageMarkdown(
  slugs: readonly string[] | undefined,
): Promise<string | null> {
  "use cache";
  cacheLife("max");
  const page = source.getPage(slugs === undefined ? undefined : [...slugs]);
  return page ? docsLlms.page(page) : null;
}

export async function GET(
  _req: Request,
  context: MarkdownRouteContext,
): Promise<Response> {
  const { slug } = await context.params;
  const slugs = slug?.slice(0, -1);
  const markdown = await pageMarkdown(
    slugs?.at(-1) === "index" ? slugs.slice(0, -1) : slugs,
  );
  if (markdown === null) notFound();

  // Next.js drops `Vary` on page responses, so only this negotiated twin can
  // tell a shared cache that the same URL also has an HTML representation.
  return new Response(markdown, {
    headers: { ...markdownHeaders, Vary: "Accept" },
  });
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    slug: getPageMarkdownUrl(page).segments,
  }));
}
