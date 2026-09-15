import { ArrowRightIcon, CloudIcon } from 'lucide-react';
import Link from 'next/link';

import { CtaGridBackground } from '@/components/blocks/cta-3/components/cta-grid-background';
import { Badge } from '@/components/reui/badge';
import { Frame, FramePanel } from '@/components/reui/frame';
import { Button } from '@/components/ui/button';
import { site } from '@/lib/site';

export function CloudCta() {
  return (
    <section className="mx-auto w-full max-w-5xl px-6 py-16 md:px-8">
      <Frame className="w-full">
        <FramePanel className="bg-muted/35 relative isolate overflow-hidden px-5 py-14 text-center sm:px-8 sm:py-16">
          <CtaGridBackground />
          <div className="relative mx-auto flex max-w-[42rem] flex-col items-center gap-8">
            <Badge variant="secondary" size="lg" className="gap-1.5">
              <CloudIcon aria-hidden="true" />
              PermDock Cloud
            </Badge>
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Governance when you want it
            </h2>
            <p className="text-muted-foreground max-w-[34rem] text-base leading-7">
              Dashboard at{' '}
              <Link
                href={site.cloud.app}
                className="text-foreground underline-offset-4 hover:underline"
              >
                app.permdock.com
              </Link>
              . API at{' '}
              <Link
                href={site.cloud.api}
                className="text-foreground underline-offset-4 hover:underline"
              >
                api.permdock.com
              </Link>
              . Read-only MCP at{' '}
              <Link
                href={site.cloud.mcp}
                className="text-foreground underline-offset-4 hover:underline"
              >
                mcp.permdock.com
              </Link>
              . The in-process defaults stay in the MIT package either way.
            </p>
            <Button
              nativeButton={false}
              render={<Link href={site.cloud.app} />}
            >
              Open Cloud
              <ArrowRightIcon aria-hidden="true" />
            </Button>
          </div>
        </FramePanel>
      </Frame>
    </section>
  );
}
