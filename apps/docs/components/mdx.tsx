import type { MDXComponents } from 'mdx/types';

import { TypeTable } from 'fumadocs-ui/components/type-table';
import defaultMdxComponents from 'fumadocs-ui/mdx';

import { Mermaid } from '@/components/mdx/mermaid';
import { Table } from '@/components/mdx/table';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    table: Table,
    TypeTable,
    Mermaid,
    ...components,
  } satisfies MDXComponents;
}

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
