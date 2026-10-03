"use client";

import type { ReactNode } from "react";

import { ArrowRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { SiteHref } from "@/lib/site";

import { SiteLink } from "@/components/site/site-link";
import { cn } from "@permdock/ui/lib/utils";
import { IconTile } from "@permdock/ui/reui/icon-tile";

export type PageHeroFeature = {
  title: string;
  description: string;
  href: SiteHref;
  icon: ReactNode;
};

/** The feature grid; it highlights each feature in turn until a pointer or focus holds it. */
export function PageHeroFeatures({
  features,
}: {
  features: readonly PageHeroFeature[];
}) {
  const first = features[0];
  const [activeTitle, setActiveTitle] = useState(first?.title ?? "");
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (held || features.length === 0) {
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
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
    <div
      className="grid grid-cols-1 gap-px border-t border-border bg-border lg:grid-cols-3"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocusCapture={() => setHeld(true)}
      onBlurCapture={() => setHeld(false)}
    >
      {features.map((feature) => {
        const isActive = feature.title === activeTitle;
        return (
          <SiteLink
            key={feature.title}
            href={feature.href}
            onClick={() => setActiveTitle(feature.title)}
            aria-current={isActive ? "true" : undefined}
            className={cn(
              "group/feature flex items-start gap-2.5 bg-background p-6 transition-colors hover:bg-muted",
              isActive && "group-not-has-[a:hover]/grid:bg-muted",
            )}
          >
            <IconTile variant="outline" size="sm" className="bg-muted">
              {feature.icon}
            </IconTile>
            <div className="flex flex-1 flex-col gap-1">
              <p className="text-sm font-medium">{feature.title}</p>
              <p className="line-clamp-3 text-sm text-muted-foreground">
                {feature.description}
              </p>
            </div>
            <ArrowRightIcon
              aria-hidden="true"
              className="size-4 shrink-0 self-center text-muted-foreground"
            />
          </SiteLink>
        );
      })}
    </div>
  );
}
