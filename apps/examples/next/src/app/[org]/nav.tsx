'use client';

import type { Permission } from 'permdock';

import Link from 'next/link';
import { usePermission } from 'permdock/react';
import { use } from 'react';

import { permissions } from '../../permissions.ts';

type Item = {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly permission: Permission | null;
  /** Rarely visited: its segment is `prefetch = 'force-disabled'`. */
  readonly prefetch?: false;
};

const items: readonly Item[] = [
  { id: 'overview', label: 'Overview', path: '', permission: null },
  {
    id: 'quotes',
    label: 'Quotes',
    path: '/quotes',
    permission: permissions.quote.list,
  },
  {
    id: 'members',
    label: 'Members',
    path: '/members',
    permission: permissions.member.list,
  },
  {
    id: 'settings',
    label: 'Settings',
    path: '/settings',
    permission: permissions.member.manage,
    prefetch: false,
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

function GatedLink(props: {
  readonly item: Item & { readonly permission: Permission };
  readonly href: string;
}) {
  const { allowed } = usePermission(props.item.permission);
  if (!allowed) {
    return null;
  }
  return (
    <li>
      <Link
        href={props.href}
        prefetch={props.item.prefetch ?? true}
        data-nav={props.item.id}
      >
        {props.item.label}
      </Link>
    </li>
  );
}

export function Nav(props: { readonly organization: Promise<string> }) {
  const organization = use(props.organization);
  return (
    <nav aria-label="Main" data-testid="nav">
      <ul>
        {items.map((item) => {
          const href = `/${organization}${item.path}`;
          return item.permission === null ? (
            <li key={item.id}>
              <Link href={href} prefetch data-nav={item.id}>
                {item.label}
              </Link>
            </li>
          ) : (
            <GatedLink
              key={item.id}
              item={{ ...item, permission: item.permission }}
              href={href}
            />
          );
        })}
      </ul>
    </nav>
  );
}
