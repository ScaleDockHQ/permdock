export const site = {
  name: 'PermDock',
  tagline:
    'Typed permissions for TypeScript apps, APIs, databases, and AI agents.',
  url: 'https://permdock.dev',
  github: 'https://github.com/ScaleDockHQ/PermDock',
  npm: 'https://www.npmjs.com/package/permdock',
  email: 'hello@permdock.dev',
  install: 'pnpm add permdock',
  getStarted: '/docs/getting-started/quick-start',
  docs: '/docs',
  cloud: {
    app: 'https://app.permdock.com',
    api: 'https://api.permdock.com',
    mcp: 'https://mcp.permdock.com',
  },
} as const;

export type NavLink = {
  readonly href: string;
  readonly label: string;
  readonly description?: string;
};

export const productLinks: readonly NavLink[] = [
  {
    href: '/cloud',
    label: 'Cloud',
    description: 'Optional decision log, hosted ADS, approval inbox.',
  },
  {
    href: '/pricing',
    label: 'Pricing',
    description: 'MIT core is free. Cloud tiers to be announced.',
  },
  {
    href: '/compare',
    label: 'Compare',
    description: 'PermDock next to CASL, Kilpi, permix and hosted PDPs.',
  },
  {
    href: '/enterprise',
    label: 'Enterprise',
    description: 'Fail-closed defaults, signed evidence, self-hosting.',
  },
];

export const resourceLinks: readonly NavLink[] = [
  { href: '/docs', label: 'Docs' },
  { href: '/docs/getting-started/quick-start', label: 'Quick start' },
  { href: '/changelog', label: 'Changelog' },
  { href: '/blog', label: 'Blog' },
  { href: '/devtools', label: 'Decide explorer' },
  { href: site.github, label: 'GitHub' },
];

export const agentRuntimes: readonly {
  readonly name: string;
  readonly href: string;
}[] = [
  { name: 'MCP', href: '/docs/adapters/mcp' },
  { name: 'AI SDK', href: '/docs/adapters/ai-sdk' },
  { name: 'Claude Agent SDK', href: '/docs/adapters/claude-agent' },
  { name: 'Eve', href: '/docs/adapters/eve' },
  { name: 'OpenAI Agents', href: '/docs/adapters/openai' },
  { name: 'WebMCP', href: '/docs/adapters/webmcp' },
  { name: 'A2A', href: '/docs/adapters/a2a' },
];

export const getStartedSteps: readonly {
  readonly title: string;
  readonly body: string;
}[] = [
  { title: 'Install', body: 'pnpm add permdock' },
  {
    title: 'Define',
    body: 'definePermissions with resource() over the schema you already have.',
  },
  {
    title: 'Policy',
    body: 'definePolicy with role(), allow() and portable conditions.',
  },
  {
    title: 'Decide',
    body: 'createPermDock, then can(), decide() or assert() on every surface.',
  },
];

export const footerColumns: readonly {
  readonly title: string;
  readonly links: readonly NavLink[];
}[] = [
  { title: 'Product', links: productLinks },
  { title: 'Resources', links: resourceLinks },
  {
    title: 'Open source',
    links: [
      { href: site.github, label: 'GitHub' },
      { href: site.npm, label: 'npm' },
      { href: '/docs/roadmap', label: 'Roadmap' },
    ],
  },
];
