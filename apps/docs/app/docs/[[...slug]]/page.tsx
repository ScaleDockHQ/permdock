import type { Metadata } from "next";

import { notFound } from "next/navigation";

import { DocsArticle } from "@/components/docs-article";
import { getPageImageUrl, source } from "@/lib/source";

type DocsPageProps = { params: Promise<{ slug?: string[] }> };

export default function Page(props: DocsPageProps) {
  return <DocsArticle slug={props.params.then((params) => params.slug)} />;
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(
  props: DocsPageProps,
): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
      types: { "text/markdown": `${page.url}.md` },
    },
    openGraph: { images: getPageImageUrl(page).url },
  };
}
