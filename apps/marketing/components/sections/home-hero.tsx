import { ArrowRightIcon } from 'lucide-react';

import { ButtonLink } from '@/components/site/button-link';
import { site } from '@/lib/site';
import { heroSnippet } from '@/lib/snippets';
import { Badge } from '@permdock/ui/reui/badge';
import {
  CodeBlock,
  CodeBlockCopyButton,
} from '@permdock/ui/reui/code-block/code-block';

import { InstallCopy } from './install-copy';

export function HomeHero() {
  return (
    <section
      id="hero"
      className="bg-background flex w-full items-center justify-center px-4 py-16 sm:px-6 lg:px-20"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-8">
        <Badge variant="outline" size="xl" radius="full" className="h-7">
          <span
            aria-hidden="true"
            className="bg-success size-1.5 shrink-0 rounded-full"
          />
          Open source. MIT. In-process.
        </Badge>
        <h1 className="text-foreground max-w-3xl text-center text-4xl font-semibold text-balance sm:text-5xl lg:text-6xl">
          Typed permissions for TypeScript apps,{' '}
          <span className="text-muted-foreground">
            APIs, databases, and AI agents.
          </span>
        </h1>
        <p className="text-muted-foreground max-w-xl text-center text-base leading-7">
          Define once. Check in React, Next.js, Hono, MCP and the Vercel AI SDK.
          The same conditions compile to SQL and Postgres RLS.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <ButtonLink size="lg" href={site.getStarted}>
            Get started
            <ArrowRightIcon aria-hidden="true" />
          </ButtonLink>
          <ButtonLink variant="outline" size="lg" href={site.github}>
            GitHub
          </ButtonLink>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <InstallCopy command={site.install} />
          <a
            href={site.npm}
            className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline"
          >
            npm
          </a>
          <span className="text-muted-foreground text-sm">MIT</span>
        </div>
        <div className="w-full max-w-2xl">
          <CodeBlock
            code={heroSnippet.code}
            language={heroSnippet.language}
            label={heroSnippet.filename}
            showLineNumbers
          >
            <CodeBlockCopyButton />
          </CodeBlock>
        </div>
      </div>
    </section>
  );
}
