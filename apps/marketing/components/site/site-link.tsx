import type { ComponentProps } from 'react';

import Link from 'next/link';

import { isCrossZone, type SiteHref } from '@/lib/site';

export type SiteLinkProps = Omit<ComponentProps<'a'>, 'href'> & {
  readonly href: SiteHref;
};

export function SiteLink({ href, children, ...props }: SiteLinkProps) {
  if (isCrossZone(href)) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} {...props}>
      {children}
    </Link>
  );
}
