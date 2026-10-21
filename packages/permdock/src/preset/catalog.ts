/**
 * The preset catalogue: every choice `/create` and `permdock init` offer. Each
 * list is append-only and its order is part of the preset code (`codec.ts`): a
 * new choice goes at the end, and a removed one keeps its slot as `retired`.
 */

export type ArchetypeId =
  | "b2b"
  | "agent"
  | "marketplace"
  | "api"
  | "internal"
  | "consumer";
export type FeatureId =
  | "tenancy"
  | "custom-roles"
  | "approvals"
  | "operations"
  | "decision-log"
  | "limits"
  | "plans"
  | "ownership"
  | "api-keys"
  | "rls";
export type AuthId = "custom" | "supabase" | "better-auth" | "clerk" | "jwt";
export type BackendId = "memory" | "supabase" | "drizzle" | "prisma";
export type FrameworkId = "next" | "hono" | "express" | "none";
export type IntegrationId = "ai-sdk" | "mcp" | "shadcn" | "react-native";
/** `agent`: an agent runtime adapter; `ui`: `@permdock` registry recipes. */
export type IntegrationKind = "agent" | "ui";
export type ServiceId =
  | "cloud-decision-log"
  | "cloud-approvals"
  | "cloud-snapshots"
  | "cloud-hosted-grants";

export type Choice<Id extends string> = {
  readonly id: Id;
  readonly title: string;
  readonly description: string;
  /** Features this choice turns on when it is picked. */
  readonly requires?: readonly FeatureId[];
  /** A choice kept only so older preset codes still decode. */
  readonly retired?: true;
};

/** An integration choice: an agent runtime adapter or a set of UI recipes. */
export type Integration = Choice<IntegrationId> & {
  readonly kind: IntegrationKind;
};

export const ARCHETYPES: readonly Choice<ArchetypeId>[] = [
  {
    id: "b2b",
    title: "B2B SaaS",
    description:
      "Organisations with owner, admin, member and viewer roles, custom roles and a decision log.",
    requires: ["tenancy", "custom-roles", "decision-log"],
  },
  {
    id: "agent",
    title: "AI agent product",
    description:
      "Tools an agent calls on a user's behalf, with human approval on the ones that change data.",
    requires: ["operations", "approvals", "decision-log"],
  },
  {
    id: "marketplace",
    title: "Marketplace",
    description:
      "Buyers and sellers who manage what they own, with refunds behind an approval.",
    requires: ["ownership", "approvals"],
  },
  {
    id: "api",
    title: "API product",
    description:
      "Projects reached through API keys, for developers and their integrations.",
    requires: ["tenancy", "api-keys", "decision-log"],
  },
  {
    id: "internal",
    title: "Internal tool",
    description:
      "Support staff, leads and admins working tickets, with approval on destructive actions.",
    requires: ["approvals", "decision-log"],
  },
  {
    id: "consumer",
    title: "Consumer app",
    description:
      "Users who own their data, with free and pro plans and a daily limit on the free plan.",
    requires: ["ownership", "plans", "limits"],
  },
];

export const FEATURES: readonly Choice<FeatureId>[] = [
  {
    id: "tenancy",
    title: "Organisations",
    description:
      "Roles held per organisation; every row carries an orgId and a member sees only their organisations.",
  },
  {
    id: "custom-roles",
    title: "Custom roles",
    description:
      "Organisation admins compose their own roles from the permissions they hold.",
    requires: ["tenancy"],
  },
  {
    id: "approvals",
    title: "Approvals",
    description:
      "Destructive actions return approval-required until a person approves them.",
  },
  {
    id: "operations",
    title: "Operations",
    description:
      "Tools an agent may call, each bound to one permission, in defineOperations.",
  },
  {
    id: "decision-log",
    title: "Decision log",
    description: "Every decision goes to a DecisionSink.",
  },
  {
    id: "limits",
    title: "Limits",
    description: "A grant allows a number of calls per time window.",
  },
  {
    id: "plans",
    title: "Plans",
    description: "Free and pro plans; pro unlocks actions the free plan lacks.",
  },
  {
    id: "ownership",
    title: "Ownership",
    description: "A user updates and deletes the rows they own.",
  },
  {
    id: "api-keys",
    title: "API keys",
    description:
      "Keys created with decideCredential, never wider than the person who creates them.",
  },
  {
    id: "rls",
    title: "Row-level security",
    description:
      "Postgres RLS policies generated from the same policy, with permdock rls generate.",
  },
];

export const AUTH: readonly Choice<AuthId>[] = [
  {
    id: "custom",
    title: "Your own session",
    description:
      "currentUser() in session.ts returns your signed-in user; until it does, every check denies.",
  },
  {
    id: "supabase",
    title: "Supabase Auth",
    description:
      "subjectFromSupabase over the claims supabase.auth.getClaims() verified.",
  },
  {
    id: "better-auth",
    title: "Better Auth",
    description:
      "subjectFromBetterAuth over the session auth.api.getSession() returns.",
  },
  {
    id: "clerk",
    title: "Clerk",
    description: "subjectFromClerk over Clerk's auth object.",
  },
  {
    id: "jwt",
    title: "Any OIDC provider",
    description:
      "subjectFromJwt verifies the bearer token through OpenID Connect Discovery.",
  },
];

export const BACKENDS: readonly Choice<BackendId>[] = [
  {
    id: "memory",
    title: "In memory",
    description: "Demo rows in a Map and memory sources, for the first run.",
  },
  {
    id: "supabase",
    title: "Supabase",
    description:
      "Memberships read through PostgREST with postgrestSources(), from the subject_for function.",
  },
  {
    id: "drizzle",
    title: "Drizzle",
    description:
      "A Drizzle schema and client; rows load by id and lists filter with toWhere().",
  },
  {
    id: "prisma",
    title: "Prisma",
    description:
      "A Prisma schema and client; rows load by id and lists filter with toWhere().",
  },
];

export const FRAMEWORKS: readonly Choice<FrameworkId>[] = [
  {
    id: "next",
    title: "Next.js",
    description: "permdock/next for Server Components, actions and routes.",
  },
  {
    id: "hono",
    title: "Hono",
    description: "permdock/hono middleware and route guards.",
  },
  {
    id: "express",
    title: "Express",
    description: "permdock/express middleware and route guards.",
  },
  {
    id: "none",
    title: "No HTTP framework",
    description: "A per-request instance from core getPermDock.",
  },
];

/**
 * Agent runtimes and UI recipes. The preset code keeps one bitset per `kind`,
 * each in this list's order, so a new entry goes after the last one of its
 * kind.
 */
export const INTEGRATIONS: readonly Integration[] = [
  {
    id: "ai-sdk",
    kind: "agent",
    title: "Vercel AI SDK",
    description: "toolApproval and needsApproval for AI SDK tools.",
    requires: ["operations"],
  },
  {
    id: "mcp",
    kind: "agent",
    title: "MCP server",
    description: "protectServer for an MCP server's tools.",
    requires: ["operations"],
  },
  {
    id: "shadcn",
    kind: "ui",
    title: "shadcn/ui",
    description: "@permdock recipes built from your shadcn components.",
  },
  {
    id: "react-native",
    kind: "ui",
    title: "React Native Reusables",
    description:
      "@permdock/*-native recipes built from React Native Reusables.",
  },
];

export const SERVICES: readonly Choice<ServiceId>[] = [
  {
    id: "cloud-decision-log",
    title: "Cloud decision log",
    description: "PermDock Cloud as the DecisionSink, with evidence exports.",
  },
  {
    id: "cloud-approvals",
    title: "Cloud approvals inbox",
    description:
      "PermDock Cloud as the ApprovalStore, with Slack and Teams delivery.",
  },
  {
    id: "cloud-snapshots",
    title: "Cloud snapshots",
    description:
      "Signed snapshots served by PermDock Cloud, through permdockCloud.snapshotsFor().",
  },
  {
    id: "cloud-hosted-grants",
    title: "Cloud hosted grants",
    description: "Grants a Cloud admin adds to hostable permissions.",
  },
];

/**
 * A complete preset: every choice `/create` and `permdock init` offer,
 * resolved.
 */
export type Preset = {
  readonly archetype: ArchetypeId;
  readonly features: readonly FeatureId[];
  readonly auth: AuthId;
  readonly backend: BackendId;
  readonly framework: FrameworkId;
  readonly integrations: readonly IntegrationId[];
  readonly services: readonly ServiceId[];
};

/**
 * What a person picks; `resolvePreset` fills in the rest from
 * `PRESET_DEFAULTS`.
 */
export type PresetInput = Partial<Preset> & { readonly archetype: ArchetypeId };

/** The choices a preset starts from, in `/create` and in `permdock init`. */
export const PRESET_DEFAULTS: Preset = Object.freeze({
  archetype: "b2b",
  features: [],
  auth: "custom",
  backend: "memory",
  framework: "next",
  integrations: [],
  services: [],
});

/** The integrations of one `kind` in `preset`, in catalogue order. */
export function integrationsOf(
  preset: Pick<Preset, "integrations">,
  kind: IntegrationKind,
): IntegrationId[] {
  return INTEGRATIONS.filter(
    (item) => item.kind === kind && preset.integrations.includes(item.id),
  ).map((item) => item.id);
}

function requiredBy(
  choices: readonly Choice<string>[],
  picked: readonly string[],
): FeatureId[] {
  return choices
    .filter((choice) => picked.includes(choice.id))
    .flatMap((choice) => choice.requires ?? []);
}

/**
 * The preset `input` describes, with every feature its archetype, integrations
 * and other features require turned on, and lists in catalogue order. Features
 * are only ever added, so resolving twice is a no-op.
 */
export function resolvePreset(input: PresetInput): Preset {
  const integrations = INTEGRATIONS.map((item) => item.id).filter((id) =>
    (input.integrations ?? PRESET_DEFAULTS.integrations).includes(id),
  );
  const features = new Set<FeatureId>([
    ...(input.features ?? PRESET_DEFAULTS.features),
    ...requiredBy(ARCHETYPES, [input.archetype]),
    ...requiredBy(INTEGRATIONS, integrations),
  ]);
  for (let added = true; added;) {
    added = false;
    for (const feature of requiredBy(FEATURES, [...features])) {
      if (!features.has(feature)) {
        features.add(feature);
        added = true;
      }
    }
  }
  return Object.freeze({
    archetype: input.archetype,
    features: FEATURES.map((feature) => feature.id).filter((id) =>
      features.has(id),
    ),
    auth: input.auth ?? PRESET_DEFAULTS.auth,
    backend: input.backend ?? PRESET_DEFAULTS.backend,
    framework: input.framework ?? PRESET_DEFAULTS.framework,
    integrations,
    services: SERVICES.map((service) => service.id).filter((id) =>
      (input.services ?? PRESET_DEFAULTS.services).includes(id),
    ),
  });
}
