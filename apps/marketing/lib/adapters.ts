export const adapterGroups = [
  {
    title: 'UI',
    tiles: [
      { name: 'React', href: '/docs/adapters/react', group: 'UI' },
      {
        name: 'React Native',
        href: '/docs/adapters/react-native',
        group: 'UI',
      },
      { name: 'Vue', href: '/docs/adapters/vue', group: 'UI' },
      { name: 'Svelte', href: '/docs/adapters/svelte', group: 'UI' },
      { name: 'Solid', href: '/docs/adapters/solid', group: 'UI' },
    ],
  },
  {
    title: 'HTTP and RPC',
    tiles: [
      { name: 'Next.js', href: '/docs/adapters/next', group: 'HTTP' },
      { name: 'Hono', href: '/docs/adapters/hono', group: 'HTTP' },
      { name: 'Express', href: '/docs/adapters/express', group: 'HTTP' },
      { name: 'Fastify', href: '/docs/adapters/fastify', group: 'HTTP' },
      { name: 'Elysia', href: '/docs/adapters/elysia', group: 'HTTP' },
      { name: 'Nest', href: '/docs/adapters/nest', group: 'HTTP' },
      { name: 'tRPC', href: '/docs/adapters/trpc', group: 'HTTP' },
      { name: 'oRPC', href: '/docs/adapters/orpc', group: 'HTTP' },
    ],
  },
  {
    title: 'Agents',
    tiles: [
      { name: 'MCP', href: '/docs/adapters/mcp', group: 'Agents' },
      { name: 'AI SDK', href: '/docs/adapters/ai-sdk', group: 'Agents' },
      {
        name: 'Claude Agent SDK',
        href: '/docs/adapters/claude-agent',
        group: 'Agents',
      },
      { name: 'Eve', href: '/docs/adapters/eve', group: 'Agents' },
      { name: 'OpenAI Agents', href: '/docs/adapters/openai', group: 'Agents' },
      { name: 'WebMCP', href: '/docs/adapters/webmcp', group: 'Agents' },
      { name: 'A2A', href: '/docs/adapters/a2a', group: 'Agents' },
    ],
  },
  {
    title: 'Data',
    tiles: [
      { name: 'Drizzle', href: '/docs/adapters/drizzle', group: 'Data' },
      { name: 'Prisma', href: '/docs/adapters/prisma', group: 'Data' },
      { name: 'Kysely', href: '/docs/adapters/kysely', group: 'Data' },
      { name: 'Postgres RLS', href: '/docs/adapters/rls', group: 'Data' },
      { name: 'Supabase', href: '/docs/adapters/supabase', group: 'Data' },
    ],
  },
  {
    title: 'Auth',
    tiles: [
      { name: 'JWT', href: '/docs/adapters/jwt', group: 'Auth' },
      {
        name: 'Better Auth',
        href: '/docs/adapters/better-auth',
        group: 'Auth',
      },
      { name: 'Clerk', href: '/docs/adapters/clerk', group: 'Auth' },
      { name: 'Convex', href: '/docs/adapters/convex', group: 'Auth' },
    ],
  },
] as const;

type AdapterGroup = (typeof adapterGroups)[number];
type TilesOf<Group> = Group extends { readonly tiles: readonly (infer Tile)[] }
  ? Tile
  : never;

export type AdapterTile = TilesOf<AdapterGroup>;

const tiles: AdapterTile[] = [];
for (const group of adapterGroups) {
  for (const tile of group.tiles) {
    tiles.push(tile);
  }
}

export const adapterTiles: readonly AdapterTile[] = tiles;
