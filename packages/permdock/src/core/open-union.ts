/**
 * A string union that stays open: the listed values autocomplete, and an
 * integrator may pass its own. Only for ids that core compares for equality,
 * where an unknown value can only fail to match. A union whose members core
 * interprets one by one (denial reasons, approval modes, condition operators,
 * credential kinds, delivery channels) stays closed.
 */
export type OpenUnion<T extends string> = T | (string & NonNullable<unknown>);

/** `actor.kind`: the values PermDock's adapters set, or an integrator's own; a policy delegation matches it by equality. */
export type ActorKind = OpenUnion<
  | "mcp-client"
  | "oauth-client"
  | "support"
  | "impersonation"
  | "ai-sdk"
  | "claude-agent"
  | "openai-agent"
  | "eve"
  | "terminal"
  | "web-bot-auth"
  | "a2a-agent"
  | "automation"
  | "job"
  | "caller"
  | "workload"
>;

/** The adapter a decision event names: a PermDock entry, or an integrator's own adapter. */
export type AdapterId = OpenUnion<
  | "server"
  | "next"
  | "hono"
  | "express"
  | "fastify"
  | "elysia"
  | "nest"
  | "node"
  | "h3"
  | "sveltekit"
  | "astro"
  | "solid-start"
  | "tanstack-start"
  | "trpc"
  | "orpc"
  | "supabase-middleware"
  | "convex"
  | "authzen"
  | "mcp"
  | "a2a"
  | "agent"
  | "ai-sdk"
  | "claude-agent"
  | "openai"
  | "eve"
  | "terminal"
  | "webmcp"
  | "workflow"
  | "chat"
  | "delivery"
>;

/** How a membership was obtained (`membership.via`); `viaOnly` and support rules match it by equality. */
export type MembershipVia = OpenUnion<
  | "direct"
  | "contact"
  | "credential"
  | "elevated"
  | "feed"
  | "link"
  | "share"
  | "support"
  | "support-session"
  | "scim"
>;
