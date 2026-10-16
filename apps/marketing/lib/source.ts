import { loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";

const blogDocs = defineDocs({
  dir: "content/blog",
});

export const blogSource = loader({
  baseUrl: "/blog",
  source: blogDocs.toFumadocsSource(),
});

/** Blog posts without `draft: true` in their frontmatter. */
export function publishedPosts() {
  return blogSource.getPages().filter((page) => {
    // SAFETY: blog frontmatter may carry `draft`; only `=== true` is trusted below
    const data = page.data as { draft?: unknown };
    return data.draft !== true;
  });
}
