import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { defineConfig } from 'fumadocs-mdx/config';
import {
  createFileSystemGeneratorCache,
  createGenerator,
  remarkAutoTypeTable,
} from 'fumadocs-typescript';

import { remarkTypeTableMarkdown } from './lib/remark-type-table-markdown';

const generator = createGenerator({
  cache: createFileSystemGeneratorCache('.next/cache/fumadocs-typescript'),
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [
      remarkMdxMermaid,
      [remarkAutoTypeTable, { generator }],
      remarkTypeTableMarkdown,
    ],
  },
});
