import type { Permission } from 'permdock';

import { permissions } from './permissions.ts';

export type NavItem = {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly permission: Permission;
  readonly pro?: true;
};

export const navItems: readonly NavItem[] = [
  {
    id: 'overview',
    label: 'Overview',
    path: '',
    permission: permissions.project.list,
  },
  {
    id: 'projects',
    label: 'Projects',
    path: '/projects',
    permission: permissions.project.list,
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
    permission: permissions.settings.manage,
  },
  {
    id: 'billing',
    label: 'Billing',
    path: '/billing',
    permission: permissions.billing.read,
  },
  {
    id: 'api-keys',
    label: 'API keys',
    path: '/api-keys',
    permission: permissions.apiKey.manage,
  },
  {
    id: 'integrations',
    label: 'Integrations',
    path: '/integrations',
    permission: permissions.integration.read,
  },
  {
    id: 'analytics',
    label: 'Analytics',
    path: '/analytics',
    permission: permissions.analytics.read,
    pro: true,
  },
  {
    id: 'audit',
    label: 'Audit log',
    path: '/audit',
    permission: permissions.audit.read,
    pro: true,
  },
  {
    id: 'sso',
    label: 'SSO',
    path: '/sso',
    permission: permissions.sso.manage,
    pro: true,
  },
];

export function navItemFor(section: string | undefined): NavItem | undefined {
  const path = section === undefined ? '' : `/${section}`;
  return navItems.find((item) => item.path === path);
}

export const orgs = [
  { id: 'acme', name: 'Acme' },
  { id: 'globex', name: 'Globex' },
] as const;

export const users = ['alice', 'bob', 'carol', 'dave'] as const;
