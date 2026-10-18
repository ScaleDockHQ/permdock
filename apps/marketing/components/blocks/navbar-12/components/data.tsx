import type { ReactNode } from 'react';

import {
  BookOpenIcon,
  BotIcon,
  CloudIcon,
  GitCompareIcon,
  LandmarkIcon,
  ScanSearchIcon,
  ScrollTextIcon,
  ShieldIcon,
} from 'lucide-react';

export type NavMegaMenuItem = {
  title: string;
  description: string;
  href: string;
  icon: ReactNode;
};

export type NavTopLevelItem = {
  title: string;
  href: '/create' | '/pricing';
};

export const NAVBAR_TOP_LEVEL: NavTopLevelItem[] = [
  { title: 'Pricing', href: '/pricing' },
  { title: 'Create', href: '/create' },
];

export const NAVBAR_PRODUCTS: NavMegaMenuItem[] = [
  {
    title: 'Cloud',
    description: 'Optional decision log, hosted ADS, approval inbox.',
    href: '/cloud',
    icon: <CloudIcon aria-hidden="true" />,
  },
  {
    title: 'Compare',
    description: 'PermDock next to CASL, Kilpi, permix and hosted PDPs.',
    href: '/compare',
    icon: <GitCompareIcon aria-hidden="true" />,
  },
  {
    title: 'Enterprise',
    description: 'Fail-closed defaults, signed evidence, self-hosting.',
    href: '/enterprise',
    icon: <LandmarkIcon aria-hidden="true" />,
  },
  {
    title: 'Decide explorer',
    description: 'Run a policy against a subject in the browser.',
    href: '/devtools',
    icon: <ScanSearchIcon aria-hidden="true" />,
  },
];

export const NAVBAR_COMPANIES: NavMegaMenuItem[] = [
  {
    title: 'Docs',
    description: 'Quick start, concepts and adapters.',
    href: '/docs',
    icon: <BookOpenIcon aria-hidden="true" />,
  },
  {
    title: 'Changelog',
    description: 'What shipped in the packages.',
    href: '/docs/changelog',
    icon: <ScrollTextIcon aria-hidden="true" />,
  },
  {
    title: 'Security',
    description: 'Threat model and secure-by-default invariants.',
    href: '/docs/security/threat-model',
    icon: <ShieldIcon aria-hidden="true" />,
  },
  {
    title: 'For AI agents',
    description: 'llms.txt, Markdown pages and the docs MCP server.',
    href: '/docs/for-ai-agents',
    icon: <BotIcon aria-hidden="true" />,
  },
];
