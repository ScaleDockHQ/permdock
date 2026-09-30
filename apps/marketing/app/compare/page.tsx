import { GitCompareIcon, LibraryIcon, NetworkIcon } from 'lucide-react';

import { PageHero } from '@/components/sections/page-hero';
import { ScrollRegion } from '@/components/site/scroll-region';
import { SiteLink } from '@/components/site/site-link';
import { compareMatrix, compareRows } from '@/lib/compare';
import { Button } from '@permdock/ui/components/button';
import { Frame, FramePanel } from '@permdock/ui/reui/frame';

export const metadata = {
  title: 'Compare',
  description:
    'PermDock next to permix, CASL, Kilpi, Better Auth access control, hosted PDPs, Cedar, OPA and the Zanzibar family.',
};

export default function ComparePage() {
  return (
    <>
      <PageHero
        badge="Comparison"
        badgeHref="/docs/comparison"
        title="In-process TypeScript, not a network PDP"
        description="Libraries that share a problem space, hosted PDPs that sit on the wire, and policy languages with their own schemas. The full write-up is in the docs."
        primary={{ href: '/docs/comparison', label: 'Full comparison' }}
        secondary={{
          href: '/docs/research/landscape',
          label: 'Landscape',
        }}
        features={[
          {
            title: 'Typed references',
            description: 'No string keys in the public API.',
            href: '/docs/getting-started/naming',
            icon: <LibraryIcon aria-hidden="true" className="size-4" />,
          },
          {
            title: 'Portable conditions',
            description: 'Memory, SQL and RLS from one AST.',
            href: '/docs/concepts/conditions',
            icon: <GitCompareIcon aria-hidden="true" className="size-4" />,
          },
          {
            title: 'Optional Cloud',
            description: 'Never on the decision path.',
            href: '/cloud',
            icon: <NetworkIcon aria-hidden="true" className="size-4" />,
          },
        ]}
      />
      <div className="mx-auto grid w-full max-w-6xl gap-4 px-6 pb-16 md:grid-cols-2 md:px-8">
        {compareRows.map((row) => (
          <Frame key={row.name}>
            <FramePanel className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">{row.name}</h2>
                <span className="text-muted-foreground text-xs">
                  {row.kind}
                </span>
              </div>
              <p className="text-muted-foreground text-sm leading-6">
                {row.take}
              </p>
              <Button
                variant="outline"
                nativeButton={false}
                render={<SiteLink href={row.href} />}
              >
                Read more
              </Button>
            </FramePanel>
          </Frame>
        ))}
      </div>
      <ScrollRegion
        aria-label="Feature comparison"
        className="mx-auto w-full max-w-6xl px-6 pb-16 md:px-8"
      >
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead>
            <tr className="border-border border-b">
              <th className="py-3 pr-4 font-medium">Feature</th>
              <th className="py-3 pr-4 font-medium">PermDock</th>
              <th className="py-3 pr-4 font-medium">Typical library</th>
              <th className="py-3 font-medium">Hosted PDP</th>
            </tr>
          </thead>
          <tbody>
            {compareMatrix.map((row) => (
              <tr key={row.feature} className="border-border border-b">
                <td className="py-3 pr-4 font-medium">{row.feature}</td>
                <td className="py-3 pr-4">{row.permdock}</td>
                <td className="text-muted-foreground py-3 pr-4">
                  {row.typicalLibrary}
                </td>
                <td className="text-muted-foreground py-3">{row.hostedPdp}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </>
  );
}
