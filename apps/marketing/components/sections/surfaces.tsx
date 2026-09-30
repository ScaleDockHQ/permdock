'use client';

import { surfaceSnippets } from '@/lib/snippets';
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

export function Surfaces() {
  const first = surfaceSnippets[0];
  if (first === undefined) {
    return null;
  }
  return (
    <Section
      id="surfaces"
      eyebrow="Every surface"
      title="One decision, every surface"
      description="The same permission reference drives UI, HTTP, MCP tools, agent runtimes and generated RLS."
    >
      <Tabs defaultValue={first.id} className="w-full">
        <Frame dense spacing="sm">
          <FrameHeader className="flex-row flex-wrap items-center gap-2">
            <FrameTitle>Adapters</FrameTitle>
            <TabsList className="bg-transparent">
              {surfaceSnippets.map((snippet) => (
                <TabsTrigger key={snippet.id} value={snippet.id}>
                  {snippet.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </FrameHeader>
          <FramePanel className="p-0!">
            {surfaceSnippets.map((snippet) => (
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
