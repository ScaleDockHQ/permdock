import Link from "next/link";
import { notFound } from "next/navigation";

import { blogSource } from "@/lib/source";

export async function BlogPost({ slug }: { readonly slug: Promise<string> }) {
  const page = blogSource.getPage([await slug]);
  if (!page) {
    notFound();
  }
  const MDX = page.data.body;
  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-16 md:px-8">
      <p className="text-sm text-muted-foreground">
        <Link href="/blog" className="underline-offset-4 hover:underline">
          Blog
        </Link>
      </p>
      <h1 className="text-4xl font-semibold tracking-tight text-balance">
        {page.data.title}
      </h1>
      {page.data.description ? (
        <p className="text-base leading-7 text-muted-foreground">
          {page.data.description}
        </p>
      ) : null}
      <div className="flex flex-col gap-4 text-base leading-7">
        <MDX />
      </div>
    </article>
  );
}
