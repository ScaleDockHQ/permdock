'use client';

import { portableSnippets } from '@/lib/snippets';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@permdock/ui/components/tabs';
import {
  CodeBlock,
  CodeBlockCopyButton,
} from '@permdock/ui/reui/code-block/code-block';
import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from '@permdock/ui/reui/frame';

import { Section } from './section';

export function PortableConditions() {
  const first = portableSnippets[0];
  if (first === undefined) {
    return null;
  }
  return (
    <Section
      id="portable"
      eyebrow="Portable-first"
      title="One where, three compilers"
      description="The same condition evaluates in memory, compiles to Drizzle, Prisma and Kysely, and generates Postgres RLS. Closures stay a branded escape hatch."
    >
      <Tabs defaultValue={first.id} className="w-full">
        <Frame dense spacing="sm">
          <FrameHeader className="flex-row items-center gap-2">
            <FrameTitle>where</FrameTitle>
            <TabsList className="ml-auto bg-transparent">
              {portableSnippets.map((snippet) => (
                <TabsTrigger key={snippet.id} value={snippet.id}>
                  {snippet.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </FrameHeader>
          <FramePanel className="p-0!">
            {portableSnippets.map((snippet) => (
              <TabsContent key={snippet.id} value={snippet.id}>
                <CodeBlock
                  code={snippet.code}
                  language={snippet.language}
                  variant="ghost"
                  showLineNumbers
                >
                  <CodeBlockCopyButton
                    variant="outline"
                    size="icon-xs"
                    className="bg-card hover:bg-muted"
                  />
                </CodeBlock>
              </TabsContent>
            ))}
          </FramePanel>
        </Frame>
      </Tabs>
    </Section>
  );
}
