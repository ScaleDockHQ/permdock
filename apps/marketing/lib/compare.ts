import type { SiteHref } from "@/lib/site";

export type CompareRow = {
  readonly name: string;
  readonly kind: string;
  readonly take: string;
  readonly href: SiteHref;
};

export const compareRows: readonly CompareRow[] = [
  {
    name: "permix",
    kind: "In-process library",
    take: "Closest adapter breadth. Mutable global core, boolean hydration, no explain, no SQL.",
    href: "/docs/research/landscape",
  },
  {
    name: "CASL v7",
    kind: "In-process library",
    take: "Mature conditions to Prisma and Mongoose. String tuples, no Standard Schema, no MCP.",
    href: "/docs/research/landscape",
  },
  {
    name: "Kilpi v1",
    kind: "In-process library",
    take: "Server-first Grant and Deny. Zod and superjson in core, no Standard Schema, RN or MCP.",
    href: "/docs/research/landscape",
  },
  {
    name: "Better Auth access control",
    kind: "Auth-bound RBAC",
    take: "Typed RBAC bound to Better Auth. PermDock layers conditions, snapshots and adapters on top.",
    href: "/docs/adapters/better-auth",
  },
  {
    name: "Hosted PDPs",
    kind: "Network PDP",
    take: "Cerbos, Permit.io, OpenFGA, SpiceDB, Oso Cloud: strings in, boolean out. PermDock embeds and can speak AuthZEN to them.",
    href: "/docs/research/landscape",
  },
  {
    name: "Cedar and OPA",
    kind: "Policy language",
    take: "Separate languages with their own schemas. PermDock keeps policy as TypeScript data.",
    href: "/docs/comparison",
  },
  {
    name: "Zanzibar family",
    kind: "Relation graph",
    take: "OpenFGA, SpiceDB, Auth0 FGA, WorkOS FGA. PermDock does not store tuples; it can PEP in front.",
    href: "/docs/comparison",
  },
];

export const compareMatrix: readonly {
  readonly feature: string;
  readonly permdock: string;
  readonly typicalLibrary: string;
  readonly hostedPdp: string;
}[] = [
  {
    feature: "Typed permission references",
    permdock: "Yes",
    typicalLibrary: "String keys or tuples",
    hostedPdp: "Strings on the wire",
  },
  {
    feature: "Standard Schema resources",
    permdock: "Yes",
    typicalLibrary: "Rare",
    hostedPdp: "No",
  },
  {
    feature: "Portable conditions to SQL and RLS",
    permdock: "Yes",
    typicalLibrary: "CASL to Prisma only",
    hostedPdp: "Query plans, not your AST",
  },
  {
    feature: "Three-outcome Decision",
    permdock: "granted, denied, approval-required",
    typicalLibrary: "Boolean",
    hostedPdp: "ALLOW or DENY",
  },
  {
    feature: "In-process, no network to decide",
    permdock: "Yes",
    typicalLibrary: "Yes",
    hostedPdp: "No",
  },
  {
    feature: "MCP, AI SDK, Eve, OpenAI Agents",
    permdock: "First-class adapters",
    typicalLibrary: "None or fail-open",
    hostedPdp: "Proxy or guide",
  },
  {
    feature: "Optional Cloud on the decision path",
    permdock: "Never",
    typicalLibrary: "N/A",
    hostedPdp: "The product is the path",
  },
];
