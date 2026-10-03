import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { defineConfig } from "fumadocs-mdx/config";
import {
  createFileSystemGeneratorCache,
  createGenerator,
  remarkAutoTypeTable,
} from "fumadocs-typescript";

import { remarkTypeTableMarkdown } from "./lib/remark-type-table-markdown";

const generator = createGenerator({
  cache: createFileSystemGeneratorCache(".next/cache/fumadocs-typescript"),
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [
      remarkMdxMermaid,
      [remarkAutoTypeTable, { generator }],
      remarkTypeTableMarkdown,
    ],
    rehypeCodeOptions: {
      // github-light tokens fall to 3.1:1 on the code background; WCAG AA needs 4.5:1.
      themes: { light: "github-light-high-contrast", dark: "github-dark" },
    },
  },
});
