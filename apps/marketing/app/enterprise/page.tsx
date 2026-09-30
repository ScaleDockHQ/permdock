import { LandmarkIcon, MailIcon, ShieldCheckIcon } from 'lucide-react';

import { Frame, FrameFooter, FramePanel } from '@/components/reui/frame';
import { PageHero } from '@/components/sections/page-hero';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { invariants } from '@/lib/invariants';
import { site } from '@/lib/site';

export const metadata = {
  title: 'Enterprise',
  description:
    'Fail-closed defaults, signed evidence, SCIM, CAEP/SSF, FAPI 2.0 and self-hosting.',
};

export default function EnterprisePage() {
  return (
    <>
      <PageHero
        badge="Enterprise"
        title="Fail-closed defaults you can take to a review"
        description="Signed decision batches, OCSF-shaped events, SCIM into a store you own, CAEP and SSF session revoke, FAPI 2.0 on the JWT path, and a Cloud you can skip."
        primary={{ href: `mailto:${site.email}`, label: 'Contact' }}
        secondary={{
          href: '/docs/security/threat-model',
          label: 'Threat model',
        }}
        features={[
          {
            title: 'Signed evidence',
            description:
              'typ permdock-decisions+jwt. Compact JWS, one private claim.',
            href: '/docs/standards/jose',
            icon: <ShieldCheckIcon aria-hidden="true" className="size-4" />,
          },
          {
            title: 'Directory you own',
            description: 'SCIM into DirectoryStore. Cloud holds no copy.',
            href: '/docs/adapters/scim',
            icon: <LandmarkIcon aria-hidden="true" className="size-4" />,
          },
          {
            title: 'Self-hosting',
            description: 'In-process defaults ship in the MIT package.',
            href: '/docs/adapters/cloud',
            icon: <MailIcon aria-hidden="true" className="size-4" />,
          },
        ]}
      />
      <div className="mx-auto grid w-full max-w-6xl gap-3 px-6 pb-12 md:grid-cols-2 md:px-8">
        {invariants.map((item) => (
          <Frame key={item.title}>
            <FramePanel className="flex flex-col gap-2">
              <h2 className="text-base font-semibold">{item.title}</h2>
              <p className="text-muted-foreground text-sm leading-6">
                {item.body}
              </p>
            </FramePanel>
          </Frame>
        ))}
      </div>
      <section className="mx-auto flex w-full max-w-2xl flex-col items-center gap-8 px-6 pb-16 text-center">
        <h2 className="text-2xl font-semibold">Contact</h2>
        <Frame className="w-full max-w-md text-left">
          <FramePanel className="p-0">
            <Item>
              <ItemMedia variant="icon">
                <MailIcon aria-hidden="true" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Email</ItemTitle>
                <ItemDescription>
                  Security, procurement and Cloud questions.
                </ItemDescription>
              </ItemContent>
            </Item>
          </FramePanel>
          <FrameFooter>
            <Button
              nativeButton={false}
              // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- Base UI renders the Button's children inside this anchor
              render={<a href={`mailto:${site.email}`} />}
              variant="outline"
              size="lg"
              className="w-full"
            >
              {site.email}
            </Button>
          </FrameFooter>
        </Frame>
      </section>
    </>
  );
}
