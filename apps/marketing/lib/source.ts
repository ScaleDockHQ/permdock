import { loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";

const blogDocs = defineDocs({
  dir: "content/blog",
});

export const blogSource = loader({
  baseUrl: "/blog",
  source: blogDocs.toFumadocsSource(),
});
