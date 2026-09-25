'use client';

import Link from 'next/link';
import { usePermission } from 'permdock/react';
import { use } from 'react';

import type { OrgView } from '../../lib/access.ts';
import type { NavItem } from '../../nav.ts';

import { navItems } from '../../nav.ts';

export function NavSkeleton() {
  return (
    <nav aria-label="Main" aria-busy="true" data-testid="nav-skeleton">
      <ul>
        {navItems.map((item) => (
          <li key={item.id}>&nbsp;</li>
        ))}
      </ul>
    </nav>
  );
}

function Item(props: { readonly item: NavItem; readonly org: OrgView }) {
  const { allowed } = usePermission(props.item.permission);
  if (allowed) {
    return (
      <li>
        <Link
          href={`/${props.org.id}${props.item.path}`}
          prefetch
          data-nav={props.item.id}
        >
          {props.item.label}
        </Link>
      </li>
    );
  }
  if (props.item.pro === true && props.org.plan !== 'pro') {
    return (
      <li data-upsell={props.item.id}>{props.item.label}: upgrade to Pro</li>
    );
  }
  return null;
}

export function Nav(props: { readonly org: Promise<OrgView | null> }) {
  const org = use(props.org);
  if (org === null) {
    return <p role="alert">Unknown organization</p>;
  }
  return (
    <nav aria-label="Main" data-testid="nav" data-plan={org.plan}>
      <ul>
        {navItems.map((item) => (
          <Item key={item.id} item={item} org={org} />
        ))}
      </ul>
    </nav>
  );
}
