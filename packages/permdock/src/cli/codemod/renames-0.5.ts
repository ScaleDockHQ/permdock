// Exclude this file from scripted identifier replacements: a `from` value must
// keep the old name, and `scripts/check-docs-drift.ts` fails when `from` equals `to`.

/**
 * One renamed identifier. `entries` are the import specifiers that export
 * `from` (`permdock`, `permdock/server`); the codemod renames only bindings
 * imported from them.
 *
 * - `export` (default): an exported value, renamed at the import and at every reference bound to it.
 * - `type`: an exported type, renamed the same way.
 * - `option`: a key of an options object passed straight to a function imported from `entries`.
 *   With `calls`, the codemod renames the key in an object literal passed straight to one of
 *   those functions; otherwise it reports every such key as a manual follow-up.
 * - `method`: a member called on the value a function imported from `entries` returns. Rewritten
 *   on a module-level `const` that holds that function's result; reported everywhere else.
 */
export type Rename = {
  readonly from: string;
  readonly to: string;
  readonly entries: readonly string[];
  readonly kind?: "export" | "option" | "method" | "type";
  readonly calls?: readonly string[];
};

/** A change the codemod reports and never rewrites: the call shape moved, not only the name. */
export type SignatureChange = {
  readonly name: string;
  readonly entries: readonly string[];
  readonly before: string;
  readonly after: string;
  /**
   * `curried`: only a call with one argument that is an object literal or
   * whose result is called has the old shape; any other call is left alone.
   */
  readonly shape?: "curried";
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
  {
    from: "createServerKernel",
    to: "createPermDock",
    entries: ["permdock/server"],
  },
  {
    from: "ServerKernel",
    to: "ServerPermDock",
    entries: ["permdock/server"],
    kind: "type",
  },
  {
    from: "ServerKernelOptions",
    to: "ServerPermDockOptions",
    entries: ["permdock/server"],
    kind: "type",
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
    from: "load",
    to: "data",
    entries: ["permdock/authzen"],
    kind: "option",
  },
  {
    from: "loadData",
    to: "data",
    entries: ["permdock/nest"],
    kind: "option",
  },
  {
    from: "onDenied",
    to: "deniedResponse",
    entries: [
      ...SERVER_ADAPTERS,
      "permdock/trpc",
      "permdock/orpc",
      "permdock/supabase/middleware",
    ],
    kind: "option",
    calls: ["createPermDock"],
  },
  {
    from: "onDenied",
    to: "deniedText",
    entries: ["permdock/ai-sdk", "permdock/mcp"],
    kind: "option",
    calls: ["createPermDock"],
  },
  {
    from: "tools",
    to: "operations",
    entries: [
      "permdock/ai-sdk",
      "permdock/openai",
      "permdock/claude-agent",
      "permdock/eve",
    ],
    kind: "option",
    calls: ["createPermDock"],
  },
  {
    from: "OnDenied",
    to: "DeniedResponse",
    entries: ["permdock/server"],
    kind: "type",
  },
  {
    from: "OnDeniedEvent",
    to: "DeniedResponseEvent",
    entries: ["permdock/server"],
    kind: "type",
  },
  {
    from: "OnDeniedText",
    to: "DeniedText",
    entries: ["permdock/ai-sdk", "permdock/mcp"],
    kind: "type",
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
    from: "ElysiaContext",
    to: "ElysiaPermDockContext",
    entries: ["permdock/elysia"],
    kind: "type",
  },
  {
    from: "ElysiaCtx",
    to: "ElysiaRequestContext",
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
  // R2 renames
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
    from: "memoryApprovalPolicies",
    to: "memoryApprovalPolicySource",
    entries: ["permdock"],
  },
  {
    from: "memoryApprovalDelegations",
    to: "memoryApprovalDelegationSource",
    entries: ["permdock/approvals"],
  },
  {
    from: "memoryAccessReviews",
    to: "memoryAccessReviewStore",
    entries: ["permdock/approvals"],
  },
  {
    from: "MemoryAccessReviews",
    to: "MemoryAccessReviewStore",
    entries: ["permdock/approvals"],
    kind: "type",
  },
  {
    from: "MemoryRelationsData",
    to: "MemoryRelationSourceData",
    entries: ["permdock"],
    kind: "type",
  },
  {
    from: "MemorySink",
    to: "MemoryDecisionSink",
    entries: ["permdock"],
    kind: "type",
  },
  {
    from: "MemorySinkOptions",
    to: "MemoryDecisionSinkOptions",
    entries: ["permdock"],
    kind: "type",
  },
  {
    from: "memoryCredentials",
    to: "memoryCredentialStore",
    entries: ["permdock/server"],
  },
  {
    from: "MemoryCredentials",
    to: "MemoryCredentialStore",
    entries: ["permdock/server"],
    kind: "type",
  },
  {
    from: "memoryStorage",
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
    from: "RoleSourceFactory",
    to: "CustomRoleSourceFactory",
    entries: ["permdock"],
    kind: "type",
  },
  {
    from: "memoryRoleSource",
    to: "memoryCustomRoleSource",
    entries: ["permdock"],
  },
  {
    from: "testRoleSource",
    to: "testCustomRoleSource",
    entries: ["permdock/testing"],
  },
  {
    from: "betterAuthRoleSource",
    to: "betterAuthCustomRoleSource",
    entries: ["permdock/better-auth"],
  },
  {
    from: "BetterAuthRoleSourceOptions",
    to: "BetterAuthCustomRoleSourceOptions",
    entries: ["permdock/better-auth"],
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
    calls: ["scimHandler"],
  },
  {
    from: "store",
    to: "reviews",
    entries: ["permdock/approvals"],
    kind: "option",
    calls: ["startAccessReview"],
  },
  {
    from: "delegations",
    to: "approvalDelegations",
    entries: ["permdock/approvals"],
    kind: "option",
    calls: ["approvalsHandler", "matchDelegation"],
  },
  { from: "source", to: "call", entries: ["permdock"], kind: "option" },
  { from: "testAuthZen", to: "testAuthzen", entries: ["permdock/testing"] },
  {
    from: "AuthZenVectors",
    to: "AuthzenVectors",
    entries: ["permdock/testing"],
    kind: "type",
  },
  {
    from: "AuthZenEvaluationVector",
    to: "AuthzenEvaluationVector",
    entries: ["permdock/testing"],
    kind: "type",
  },
  {
    from: "AuthZenEvaluationsVector",
    to: "AuthzenEvaluationsVector",
    entries: ["permdock/testing"],
    kind: "type",
  },
  {
    from: "AuthZenSearchVector",
    to: "AuthzenSearchVector",
    entries: ["permdock/testing"],
    kind: "type",
  },
  {
    from: "TestAuthZenOptions",
    to: "TestAuthzenOptions",
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
  {
    from: "ApprovalResumeFailure",
    to: "ApprovalResumeFailureCause",
    entries: ["permdock/approvals"],
    kind: "type",
  },
  // T renames
  {
    from: "window",
    to: "per",
    entries: ["permdock", ...SERVER_ADAPTERS],
    kind: "method",
  },
  // Repo standard 1.13 renames
  {
    from: "DefinePermissionsOptions",
    to: "PermissionsOptions",
    entries: ["permdock"],
    kind: "type",
  },
  {
    from: "SignCapabilityOptions",
    to: "CapabilityOptions",
    entries: ["permdock"],
    kind: "type",
  },
  {
    from: "SignRunTicketOptions",
    to: "RunTicketOptions",
    entries: ["permdock/server"],
    kind: "type",
  },
  {
    from: "StartAccessReviewOptions",
    to: "AccessReviewOptions",
    entries: ["permdock/approvals"],
    kind: "type",
  },
  {
    from: "StartAutomationOptions",
    to: "AutomationOptions",
    entries: ["permdock/workflow", "permdock/workflow-sdk"],
    kind: "type",
  },
  {
    from: "VerifyWebhookOptions",
    to: "WebhookOptions",
    entries: ["permdock/cloud"],
    kind: "type",
  },
  {
    from: "UseRolesOptions",
    to: "RolesOptions",
    entries: ["permdock/vue", "permdock/svelte", "permdock/solid"],
    kind: "type",
  },
  {
    from: "ConvexCtxLike",
    to: "ConvexContextLike",
    entries: ["permdock/convex"],
    kind: "type",
  },
  {
    from: "createJwtSubjectResolver",
    to: "jwtSubjectResolver",
    entries: ["permdock/jwt"],
  },
  {
    from: "createClerkSubjectResolver",
    to: "clerkSubjectResolver",
    entries: ["permdock/clerk"],
  },
  {
    from: "fromResponse",
    to: "sendResponse",
    entries: ["permdock/node"],
  },
  {
    from: "fromResponse",
    to: "send",
    entries: ["permdock/node"],
    kind: "method",
  },
  // use* on the client, get* on the server
  {
    from: "createPermDock",
    to: "getPermDockSync",
    entries: ["permdock"],
  },
  {
    from: "createPermDock",
    to: "getPermDock",
    entries: ["permdock/pdp"],
  },
  {
    from: "loadRelations",
    to: "prefetchRelations",
    entries: ["permdock", "permdock/pdp"],
    kind: "method",
  },
];

/** Every 0.5.0 rename, one row per `from` and target. */
export const RENAMES_0_5: readonly Rename[] = Object.freeze(
  rows.map((row) =>
    Object.freeze({
      ...row,
      entries: Object.freeze([...row.entries]),
      ...(row.calls === undefined
        ? {}
        : { calls: Object.freeze([...row.calls]) }),
    }),
  ),
);

/** 0.5.0 changes the codemod lists as manual follow-ups. */
export const SIGNATURE_CHANGES_0_5: readonly SignatureChange[] = Object.freeze([
  {
    name: "permittedIds",
    entries: ["permdock"],
    before: "permittedIds(permdock, permission, scope)",
    after: "permdock.permittedIds(permission, scope)",
  },
  {
    name: "mayUse",
    entries: ["permdock"],
    before: "mayUse(permdock, permission)",
    after: "permdock.mayUse(permission)",
  },
  {
    name: "subjectFromApiKey",
    entries: ["permdock/server"],
    before: "subjectFromApiKey(options)(key)",
    after: "subjectFromApiKey(key, options)",
    shape: "curried",
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
  {
    name: "MappedSubject",
    entries: ["permdock/jwt"],
    before: "MappedSubject",
    after: "Subject<JwtPrincipal>",
  },
  {
    name: "verifyWebBotAuth",
    entries: SERVER_ADAPTERS,
    before: "verifyWebBotAuth(request, options)",
    after: "webBotAuthVerifier(options)(request)",
  },
  {
    name: "verifyWebhook",
    entries: ["permdock/cloud"],
    before: "verifyWebhook(request, options).reason",
    after: "verifyWebhook(request, options).cause",
  },
  {
    name: "inspectApproval",
    entries: ["permdock/approvals"],
    before: "inspectApproval(store, token).detail",
    after: "inspectApproval(store, token).cause",
  },
  {
    name: "consumeApproval",
    entries: ["permdock/approvals"],
    before: "consumeApproval(store, token).detail",
    after: "consumeApproval(store, token).cause",
  },
  {
    name: "requireAccess",
    entries: ["permdock/next"],
    before: "requireAccess({ permission, data, tenant, onDenied })",
    after: "requirePermission(permission, data, { tenant, onDenied })",
  },
  {
    name: "RequireAccessInput",
    entries: ["permdock/next"],
    before: "RequireAccessInput",
    after: "PermissionRequirementOptions",
  },
]);
