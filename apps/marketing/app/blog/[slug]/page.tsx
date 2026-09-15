import Link from 'next/link';
import { notFound } from 'next/navigation';

import { blogSource } from '@/lib/source';

type BlogPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function BlogPostPage(props: BlogPageProps) {
  const { slug } = await props.params;
  const page = blogSource.getPage([slug]);
  if (!page) {
    notFound();
  }
  const MDX = page.data.body;
  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-16 md:px-8">
      <p className="text-muted-foreground text-sm">
        <Link href="/blog" className="underline-offset-4 hover:underline">
          Blog
        </Link>
      </p>
      <h1 className="text-4xl font-semibold tracking-tight text-balance">
        {page.data.title}
      </h1>
      {page.data.description ? (
        <p className="text-muted-foreground text-base leading-7">
          {page.data.description}
        </p>
      ) : null}
      <div className="flex flex-col gap-4 text-base leading-7">
        <MDX />
      </div>
    </article>
  );
}

export function generateStaticParams() {
  return blogSource.getPages().flatMap((page) => {
    const slug = page.slugs[0];
    if (slug === undefined) {
      return [];
    }
    return [{ slug }];
  });
}

export async function generateMetadata(props: BlogPageProps) {
  const { slug } = await props.params;
  const page = blogSource.getPage([slug]);
  if (!page) {
    notFound();
  }
  return {
    title: page.data.title,
    description: page.data.description,
  };
}
