import Link from 'next/link';

import { Frame, FramePanel } from '@/components/reui/frame';
import { Button } from '@/components/ui/button';
import { site } from '@/lib/site';

import { Section } from './section';

export function CloudBand() {
  return (
    <Section
      id="cloud"
      eyebrow="Optional"
      title="The Cloud is optional"
      description="Every hosted capability has an in-process default. A store or sink never influences an outcome. Cloud outages do not change can() or decide()."
    >
      <Frame>
        <FramePanel className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground max-w-xl text-sm leading-6">
            Decision log as evidence, hosted AuthZEN ADS, approval inbox, SCIM
            relay. None of it sits on the decision path.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button nativeButton={false} render={<Link href="/cloud" />}>
              PermDock Cloud
            </Button>
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href={site.cloud.app} />}
            >
              Open Cloud
            </Button>
          </div>
        </FramePanel>
      </Frame>
    </Section>
  );
}
