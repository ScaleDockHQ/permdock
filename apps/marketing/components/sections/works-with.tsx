import { SiteLink } from '@/components/site/site-link';
import { adapterGroups } from '@/lib/adapters';
import { Frame, FrameFooter, FramePanel } from '@permdock/ui/reui/frame';
import { IconTile } from '@permdock/ui/reui/icon-tile';

import { AdapterLogo } from './adapter-logos';
import { Section } from './section';

export function WorksWith() {
  return (
    <Section
      id="works-with"
      eyebrow="Works with"
      title="Adapters you already ship"
      description="Each tile is a first-class entry. The public API is typed permission references, never string keys."
    >
      <div className="flex flex-col gap-10">
        {adapterGroups.map((group) => (
          <div key={group.title} className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold tracking-wide uppercase">
              {group.title}
            </h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {group.tiles.map((tile) => (
                <Frame key={tile.name} variant="inverse">
                  <FramePanel className="px-3.5 py-6 text-center shadow-none!">
                    <IconTile variant="elevated" size="lg" className="mx-auto">
                      <AdapterLogo name={tile.name} />
                    </IconTile>
                  </FramePanel>
                  <FrameFooter className="px-1.5! py-2.5! text-center">
                    <SiteLink
                      href={tile.href}
                      className="hover:text-primary text-sm leading-tight font-medium"
                    >
                      {tile.name}
                    </SiteLink>
                  </FrameFooter>
                </Frame>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
