import { ArrowUpRightIcon } from 'lucide-react';

import type { SiteHref } from '@/lib/site';

import { ButtonLink } from '@/components/site/button-link';
import { SiteLink } from '@/components/site/site-link';
import { Badge } from '@permdock/ui/reui/badge';

import { PageHeroFeatures, type PageHeroFeature } from './page-hero-features';

export function PageHero({
  badge,
  badgeHref,
  title,
  description,
  primary,
  secondary,
  features,
}: {
  badge: string;
  badgeHref?: SiteHref;
  title: string;
  description: string;
  primary: { href: SiteHref; label: string };
  secondary: { href: SiteHref; label: string };
  features: readonly PageHeroFeature[];
}) {
  return (
    <section className="bg-background w-full px-4 py-12 sm:px-6 lg:px-20">
      <div className="border-border mx-auto w-full max-w-6xl overflow-hidden rounded-xl border">
        <div className="flex flex-col items-start gap-4 px-6 pt-12 pb-6 sm:pt-16">
          <Badge
            variant="outline"
            radius="full"
            render={badgeHref ? <SiteLink href={badgeHref} /> : undefined}
            className="h-7 gap-1.5 px-2 text-sm font-medium"
          >
            <span
              aria-hidden="true"
              className="bg-success size-1.5 shrink-0 rounded-full"
            />
            {badge}
            <ArrowUpRightIcon
              aria-hidden="true"
              className="text-muted-foreground size-3.5"
            />
          </Badge>
          <h1 className="text-foreground max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl lg:text-5xl">
            {title}
          </h1>
          <p className="text-muted-foreground max-w-3xl text-base leading-6">
            {description}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <ButtonLink href={primary.href}>{primary.label}</ButtonLink>
            <ButtonLink variant="outline" href={secondary.href}>
              {secondary.label}
            </ButtonLink>
          </div>
        </div>
        <PageHeroFeatures features={features} />
      </div>
    </section>
  );
}
