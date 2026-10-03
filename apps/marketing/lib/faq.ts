export type FaqItem = {
  readonly question: string;
  readonly answer: string;
};

export const faqItems: readonly FaqItem[] = [
  {
    question: "How is PermDock licensed?",
    answer:
      "The library is MIT. Every decision runs in-process. PermDock Cloud is optional and never sits on the decision path.",
  },
  {
    question: "Does a check require a network call?",
    answer:
      "No. createPermDock evaluates locally. permdock/pdp is the only opt-in remote exception. Cloud outages do not change can() or decide().",
  },
  {
    question: "What happens when a grant is missing?",
    answer:
      "Fail-closed. No grant, unknown role, invalid boundary data, unrecognised remote decision, and a thrown closure all deny. can() never throws.",
  },
  {
    question: "Do I write permissions as strings?",
    answer:
      "No. The public API uses references such as permissions.post.update. Strings appear only as .key and .scope on the wire, in audit, catalogs and findPermission().",
  },
  {
    question: "Where does authentication live?",
    answer:
      "Upstream. Core never verifies a token. subjectFromJwt, subjectFromSupabase, subjectFromClerk and subjectFromBetterAuth hand core a Subject. An unverifiable token becomes the anonymous subject.",
  },
  {
    question: "Can the same condition reach SQL?",
    answer:
      "Yes. Portable conditions evaluate in memory, filter arrays, compile to Drizzle, Prisma and Kysely where clauses, and generate Postgres RLS. Closures stay a branded escape hatch.",
  },
  {
    question: "How do agent tool calls get gated?",
    answer:
      "The same Decision drives MCP, the Vercel AI SDK, the Claude Agent SDK, Eve, the OpenAI Agents SDK, WebMCP and A2A. granted, denied and approval-required map to each runtime hook. An agent never approves its own call.",
  },
  {
    question: "What is PermDock Cloud for?",
    answer:
      "Governance, not decisions: a decision log sold as evidence, a hosted AuthZEN ADS, an approval inbox, and a SCIM relay into a DirectoryStore you own. Dashboard at app.permdock.com, API at api.permdock.com, read-only MCP at mcp.permdock.com. Every hosted capability has an in-process default in the open-source package.",
  },
];
