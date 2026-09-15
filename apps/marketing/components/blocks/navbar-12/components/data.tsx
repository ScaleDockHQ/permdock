import type { ReactNode } from 'react';

import {
  BookOpenIcon,
  CloudIcon,
  GitCompareIcon,
  LandmarkIcon,
  NewspaperIcon,
  ScrollTextIcon,
  ShieldIcon,
  SparklesIcon,
} from 'lucide-react';

export type NavMegaMenuItem = {
  title: string;
  description: string;
  href: string;
  icon: ReactNode;
};

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
    title: 'Pricing',
    description: 'MIT core is free. Cloud tiers to be announced.',
    href: '/pricing',
    icon: <SparklesIcon aria-hidden="true" />,
  },
];

export const NAVBAR_COMPANIES: NavMegaMenuItem[] = [
  {
    title: 'Docs',
    description: 'Quick start, adapters and ADRs.',
    href: '/docs',
    icon: <BookOpenIcon aria-hidden="true" />,
  },
  {
    title: 'Changelog',
    description: 'What shipped in the packages.',
    href: '/changelog',
    icon: <ScrollTextIcon aria-hidden="true" />,
  },
  {
    title: 'Blog',
    description: 'Product notes and launch posts.',
    href: '/blog',
    icon: <NewspaperIcon aria-hidden="true" />,
  },
  {
    title: 'Security',
    description: 'Threat model and secure-by-default invariants.',
    href: '/docs/security/threat-model',
    icon: <ShieldIcon aria-hidden="true" />,
  },
];
