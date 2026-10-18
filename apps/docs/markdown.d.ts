// A Markdown import compiled by the fumadocs-mdx loader (`createMDX` in next.config.ts).
declare module "*.md" {
  import type { TOCItemType } from "fumadocs-core/toc";
  import type { MDXContent } from "mdx/types";

  export const toc: TOCItemType[];
  const MDXComponent: MDXContent;
  export default MDXComponent;
}
