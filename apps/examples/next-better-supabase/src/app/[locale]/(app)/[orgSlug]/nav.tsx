'use client';

import type { Permission } from 'permdock';

import Link from 'next/link';
import { usePermission } from 'permdock/react';
import { use } from 'react';

import { permissions } from '../../../../policy.ts';

type Item = {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly permission: Permission;
};

const items: readonly Item[] = [
  {
    id: 'staff',
    label: 'Staff',
    path: '/staff',
    permission: permissions.staff.list,
  },
  {
    id: 'quotes',
    label: 'Quotes',
    path: '/quotes',
    permission: permissions.quotes.list,
  },
];

export function NavSkeleton() {
  return (
    <nav aria-label="Main" aria-busy="true" data-testid="nav-skeleton">
      <ul>
        {items.map((item) => (
          <li key={item.id}>&nbsp;</li>
        ))}
      </ul>
    </nav>
  );
}

function GatedLink(props: { readonly item: Item; readonly href: string }) {
  const { allowed } = usePermission(props.item.permission);
  if (!allowed) {
    return null;
  }
  return (
    <li>
      <Link href={props.href} prefetch data-nav={props.item.id}>
        {props.item.label}
      </Link>
    </li>
  );
}

export function Nav(props: { readonly base: Promise<string> }) {
  const base = use(props.base);
  return (
    <nav aria-label="Main" data-testid="nav">
      <ul>
        {items.map((item) => (
          <GatedLink key={item.id} item={item} href={`${base}${item.path}`} />
        ))}
      </ul>
    </nav>
  );
}
