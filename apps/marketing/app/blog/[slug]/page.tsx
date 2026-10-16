import { notFound } from "next/navigation";

import { BlogPost } from "@/components/blog/blog-post";
import { blogSource } from "@/lib/source";

type BlogPageProps = {
  params: Promise<{ slug: string }>;
};

export default function BlogPostPage(props: BlogPageProps) {
  return <BlogPost slug={props.params.then((params) => params.slug)} />;
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
