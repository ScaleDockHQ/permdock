'use client';

import type { ReactNode } from 'react';

import { ArrowRightIcon, ArrowUpRightIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/reui/badge';
import { IconTile } from '@/components/reui/icon-tile';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type PageHeroFeature = {
  title: string;
  description: string;
  href: string;
  icon: ReactNode;
};

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
  badgeHref?: string;
  title: string;
  description: string;
  primary: { href: string; label: string };
  secondary: { href: string; label: string };
  features: readonly PageHeroFeature[];
}) {
  const first = features[0];
  const [activeTitle, setActiveTitle] = useState(first?.title ?? '');
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (held || features.length === 0) {
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    const timer = setTimeout(() => {
      setActiveTitle((current) => {
        const index = features.findIndex(
          (feature) => feature.title === current,
        );
        return features[(index + 1) % features.length]?.title ?? current;
      });
    }, 2200);
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new title re-arms the timer, including after a click
  }, [activeTitle, features, held]);

  return (
    <section className="bg-background w-full px-4 py-12 sm:px-6 lg:px-20">
      <div className="border-border mx-auto w-full max-w-6xl overflow-hidden rounded-xl border">
        <div className="flex flex-col items-start gap-4 px-6 pt-12 pb-6 sm:pt-16">
          <Badge
            variant="outline"
            radius="full"
            render={badgeHref ? <Link href={badgeHref} /> : undefined}
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
            <Button nativeButton={false} render={<Link href={primary.href} />}>
              {primary.label}
            </Button>
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href={secondary.href} />}
            >
              {secondary.label}
            </Button>
          </div>
        </div>
        <div
          className="bg-border border-border grid grid-cols-1 gap-px border-t lg:grid-cols-3"
          onPointerEnter={() => setHeld(true)}
          onPointerLeave={() => setHeld(false)}
          onFocusCapture={() => setHeld(true)}
          onBlurCapture={() => setHeld(false)}
        >
          {features.map((feature) => {
            const isActive = feature.title === activeTitle;
            return (
              <Link
                key={feature.title}
                href={feature.href}
                onClick={() => setActiveTitle(feature.title)}
                aria-current={isActive ? 'true' : undefined}
                className={cn(
                  'group/feature bg-background hover:bg-muted flex items-start gap-2.5 p-6 transition-colors',
                  isActive && 'group-not-has-[a:hover]/grid:bg-muted',
                )}
              >
                <IconTile variant="outline" size="sm" className="bg-muted">
                  {feature.icon}
                </IconTile>
                <div className="flex flex-1 flex-col gap-1">
                  <p className="text-sm font-medium">{feature.title}</p>
                  <p className="text-muted-foreground line-clamp-3 text-sm">
                    {feature.description}
                  </p>
                </div>
                <ArrowRightIcon
                  aria-hidden="true"
                  className="text-muted-foreground size-4 shrink-0 self-center"
                />
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
