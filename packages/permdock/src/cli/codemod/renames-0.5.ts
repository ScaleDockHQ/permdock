/**
 * One renamed identifier. `entries` are the import specifiers that export
 * `from` (`permdock`, `permdock/server`); the codemod renames only bindings
 * imported from them.
 *
 * - `export` (default): an exported value, renamed at the import and at every reference bound to it.
 * - `type`: an exported type, renamed the same way.
 * - `option`: a key of an options object passed straight to a function imported from `entries`.
 * - `method`: a member called on the value a function imported from `entries` returns.
 */
export type Rename = {
  readonly from: string;
  readonly to: string;
  readonly entries: readonly string[];
  readonly kind?: "export" | "option" | "method" | "type";
};

/** A change the codemod reports and never rewrites: the call shape moved, not only the name. */
export type SignatureChange = {
  readonly name: string;
  readonly entries: readonly string[];
  readonly before: string;
  readonly after: string;
};

const SERVER_ADAPTERS = [
  "permdock/server",
  "permdock/hono",
  "permdock/express",
  "permdock/fastify",
  "permdock/elysia",
  "permdock/nest",
  "permdock/node",
] as const;

const rows: readonly Rename[] = [
  // R1 renames
  // R2 renames
  // R3 renames
  {
    from: "createServerKernel",
    to: "createPermDock",
    entries: ["permdock/server"],
  },
  {
    from: "createEvaluationsHandler",
    to: "evaluationsHandler",
    entries: ["permdock/server"],
  },
  {
    from: "createNativeStore",
    to: "nativeStore",
    entries: ["permdock/react-native"],
  },
  {
    from: "permdock",
    to: "getPermDock",
    entries: [
      "permdock/server",
      "permdock/node",
      "permdock/terminal",
      "permdock/openai",
      "permdock/claude-agent",
      "permdock/eve",
    ],
    kind: "method",
  },
  {
    from: "permdock",
    to: "middleware",
    entries: [
      "permdock/hono",
      "permdock/express",
      "permdock/elysia",
      "permdock/trpc",
      "permdock/orpc",
    ],
    kind: "method",
  },
  {
    from: "subjectFromSession",
    to: "subjectFromEve",
    entries: ["permdock/eve"],
  },
  { from: "actorFromSession", to: "actorFromEve", entries: ["permdock/eve"] },
  {
    from: "CredentialPrincipal",
    to: "ApiKeyPrincipal",
    entries: ["permdock"],
    kind: "type",
  },
  {
    from: "LinkPrincipal",
    to: "CapabilityPrincipal",
    entries: ["permdock"],
    kind: "type",
  },
  {
    from: "SsfSubjectMapper",
    to: "SsfSubjectResolver",
    entries: ["permdock/ssf"],
    kind: "type",
  },
  {
    from: "memorySettings",
    to: "memorySettingsSource",
    entries: ["permdock"],
  },
  {
    from: "memoryRelations",
    to: "memoryRelationSource",
    entries: ["permdock"],
  },
  { from: "memorySink", to: "memoryDecisionSink", entries: ["permdock"] },
  {
    from: "memoryApprovalPolicySource",
    to: "memoryApprovalPolicySource",
    entries: ["permdock"],
  },
  {
    from: "memoryApprovalDelegationSource",
    to: "memoryApprovalDelegationSource",
    entries: ["permdock/approvals"],
  },
  {
    from: "memoryAccessReviewStore",
    to: "memoryAccessReviewStore",
    entries: ["permdock/approvals"],
  },
  {
    from: "memoryCredentialStore",
    to: "memoryCredentialStore",
    entries: ["permdock/server"],
  },
  {
    from: "memorySnapshotStorage",
    to: "memorySnapshotStorage",
    entries: ["permdock/react-native"],
  },
  { from: "rlsParity", to: "testRlsParity", entries: ["permdock/testing"] },
  { from: "ormParity", to: "testOrmParity", entries: ["permdock/testing"] },
  {
    from: "fromStripeEntitlements",
    to: "stripeEntitlementSource",
    entries: ["permdock"],
  },
  {
    from: "fromTable",
    to: "tableMembershipSource",
    entries: ["permdock/supabase"],
  },
  {
    from: "fromJunction",
    to: "junctionMembershipSource",
    entries: ["permdock/supabase"],
  },
  {
    from: "fromSupabasePostgres",
    to: "supabasePostgresQuery",
    entries: ["permdock/supabase"],
  },
  {
    from: "verifyWebBotAuth",
    to: "webBotAuthVerifier",
    entries: SERVER_ADAPTERS,
  },
  {
    from: "RoleSource",
    to: "CustomRoleSource",
    entries: ["permdock"],
    kind: "type",
  },
  {
    from: "PermDockStorage",
    to: "SnapshotStorage",
    entries: ["permdock/react-native"],
    kind: "type",
  },
  {
    from: "store",
    to: "directory",
    entries: ["permdock/scim"],
    kind: "option",
  },
  {
    from: "store",
    to: "reviews",
    entries: ["permdock/approvals"],
    kind: "option",
  },
  {
    from: "delegations",
    to: "approvalDelegations",
    entries: ["permdock/approvals"],
    kind: "option",
  },
  { from: "source", to: "call", entries: ["permdock"], kind: "option" },
  {
    from: "loadData",
    to: "data",
    entries: ["permdock", ...SERVER_ADAPTERS, "permdock/next"],
    kind: "option",
  },
  {
    from: "load",
    to: "data",
    entries: ["permdock", ...SERVER_ADAPTERS, "permdock/next"],
    kind: "option",
  },
  {
    from: "PermDockRequest",
    to: "ExpressPermDockRequest",
    entries: ["permdock/express"],
    kind: "type",
  },
  {
    from: "PermDockRequest",
    to: "FastifyPermDockRequest",
    entries: ["permdock/fastify"],
    kind: "type",
  },
  {
    from: "PermDockEnv",
    to: "HonoPermDockEnv",
    entries: ["permdock/hono"],
    kind: "type",
  },
  {
    from: "ElysiaCtx",
    to: "ElysiaPermDockContext",
    entries: ["permdock/elysia"],
    kind: "type",
  },
  {
    from: "ConvexPermDockCtx",
    to: "ConvexPermDockContext",
    entries: ["permdock/convex"],
    kind: "type",
  },
  {
    from: "ServerPermDockProviderProps",
    to: "NextPermDockProviderProps",
    entries: ["permdock/next"],
    kind: "type",
  },
  {
    from: "NativePermDockProviderProps",
    to: "ReactNativePermDockProviderProps",
    entries: ["permdock/react-native"],
    kind: "type",
  },
  {
    from: "PermDockSvelteOptions",
    to: "SveltePermDockOptions",
    entries: ["permdock/svelte"],
    kind: "type",
  },
  { from: "testAuthZen", to: "testAuthzen", entries: ["permdock/testing"] },
  {
    from: "AuthZenVectors",
    to: "AuthzenVectors",
    entries: ["permdock/testing"],
    kind: "type",
  },
  {
    from: "powersyncSource",
    to: "powerSyncSource",
    entries: ["permdock/react-native"],
  },
  {
    from: "summariseSubject",
    to: "summarizeSubject",
    entries: ["permdock/approvals"],
  },
  {
    from: "WebhookFailureReason",
    to: "WebhookFailureCause",
    entries: ["permdock/cloud"],
    kind: "type",
  },
];

/** Every 0.5.0 rename, one row per `from` and target. */
export const RENAMES_0_5: readonly Rename[] = Object.freeze(
  rows.map((row) => Object.freeze({ ...row, entries: [...row.entries] })),
);

/** 0.5.0 changes the codemod lists as manual follow-ups. */
export const SIGNATURE_CHANGES_0_5: readonly SignatureChange[] = Object.freeze([
  {
    name: "decideCredential",
    entries: ["permdock"],
    before: "decideCredential(permdock, request)",
    after: "permdock.decideCredential(request)",
  },
  {
    name: "permittedIds",
    entries: ["permdock"],
    before: "permittedIds(permdock, permission, rows)",
    after: "permdock.permittedIds(permission, rows)",
  },
  {
    name: "mayUse",
    entries: ["permdock"],
    before: "mayUse(permdock, ...)",
    after: "permdock.mayUse(...)",
  },
  {
    name: "subjectFromApiKey",
    entries: ["permdock/server"],
    before: "subjectFromApiKey(options)(key)",
    after: "subjectFromApiKey(key, options)",
  },
  {
    name: "subjectFromBetterAuth",
    entries: ["permdock/better-auth"],
    before: "subjectFromBetterAuth(auth, session, options)",
    after: "subjectFromBetterAuth(session, { auth, ...options })",
  },
  {
    name: "capabilitySubject",
    entries: ["permdock"],
    before: "capabilitySubject(...)",
    after: "subjectFromCapability(token, options)",
  },
  {
    name: "credentialSubject",
    entries: ["permdock"],
    before: "credentialSubject(...)",
    after: "subjectFromApiKey(key, options)",
  },
]);
