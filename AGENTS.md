# AGENTS.md — maintainer guide for PermDock

This file is for agents and humans changing the PermDock repository. It is not the consumer skill: consumers get `wire-permdock` and `audit-permissions` from the `permdock` package (`npx skills add ScaleDockHQ/PermDock`). `CLAUDE.md` is a symlink to this file; do not fork the two.

The product plan and every design decision live in `PRODUCT.md` and `apps/docs/content/docs/`. Read `apps/docs/content/docs/index.mdx`, `getting-started/naming.mdx` and `security/threat-model.mdx` before touching code.

## Status

Phase 0. The docs tree, README, PRODUCT, this file, the repo tooling (pnpm 12 workspace, Turborepo, Oxlint, Oxfmt, Lefthook, Changesets) and the two private config packages (`packages/typescript-config`, `packages/ox-config`) exist; `packages/permdock`, `apps/docs` (the app itself), `apps/examples/` and `tests/` do not yet. Anything you add must match the layout below so Phase 1 does not have to move it.

## Repo layout

```
packages/
  permdock/           npm `permdock` — src/core, src/conditions, one folder per subpath adapter
                      (react, react-native, next, vue, svelte, solid, server, hono, express, fastify,
                       elysia, nest, node, terminal, trpc, orpc, mcp, ai-sdk, claude-agent, eve, openai, webmcp, a2a,
                       authzen, approvals, cloud, ssf, openapi, otel, drizzle, prisma, kysely, jwt, supabase,
                       better-auth, clerk, convex, pdp)
                      skills/ (wire-permdock, audit-permissions) shipped in the package
  cli/                npm `@permdock/cli` — collect, catalog, usage, openapi, rls, doctor, skills;
                      also exports `permdock/next/plugin` (createPermDockPlugin) and `@permdock/cli/unplugin`
                      (createPermDockUnplugin for Vite / Rollup / webpack / Rspack / esbuild): both build-time collect only;
                      ships the Spectral / Redocly / vacuum ruleset file for `permdock openapi` invariants
  testing/            npm `@permdock/testing` — policy matrix tests, snapshot fixtures, RLS parity runner, instant() helpers
  typescript-config/  private `@permdock/typescript-config` — tsconfig presets every workspace extends:
                      base.json, library.json (tsdown packages), react-library.json, next.json
  ox-config/          private `@permdock/ox-config` — `oxlint` (`base`, `ignorePatterns`) and `oxfmt` (`oxfmt()` factory);
                      the root oxlint.config.ts / oxfmt.config.ts only add repo-specific ignores, `typeAware` and the packages/** override
apps/
  docs/               Fumadocs v16 on Next.js 16.3; content in apps/docs/content/docs (exists today)
  examples/<name>/    one app per adapter: next, react-vite, expo, vue, svelte, solid, hono, express, fastify,
                      elysia, nest, terminal, trpc, orpc, mcp-server, ai-sdk-agent, claude-agent, eve-agent,
                      openai-agent, webmcp, a2a-agent, authzen-pdp, supabase-rls, drizzle, prisma, better-auth,
                      clerk, convex, monorepo
                      (eve-agent doubles as the PermDock Cloud template on the Vercel Marketplace)
tests/
  e2e/                Playwright across examples, including @next/playwright instant()
  types/              TS 5.9 / 6 / 7 matrix
  integration/        Postgres via testcontainers: RLS parity, providers
  bundle/             per-entry gzip measurements; baseline set after core ships
```

## Commands (once Phase 1 lands; keep these names)

```bash
pnpm install
pnpm build                 # turbo run build (tsdown)
pnpm test                  # vitest unit + type tests
pnpm test:e2e              # playwright across apps/examples
pnpm test:integration      # testcontainers Postgres
pnpm lint && pnpm fmt      # oxlint, oxfmt (root scripts, whole repo; config comes from packages/ox-config)
pnpm typecheck             # turbo run typecheck (tsc --noEmit per package, presets from packages/typescript-config)
pnpm check                 # fmt:check + lint + typecheck; what CI and the pre-push hook run
pnpm check:publish         # publint + arethetypeswrong on every package
pnpm size                  # per-entry gzip measurements
pnpm docs:dev              # apps/docs
pnpm permdock collect --check   # catalog drift (also run in CI)
pnpm changeset             # every user-visible change
```

## Invariants (a PR that breaks one is wrong, whatever else it does)

1. **Fail-closed.** No grant, unknown role, invalid boundary data, unrecognised remote decision, thrown closure: all deny. `can()` never throws. `Decision.outcome` is only `granted`, `denied` or `approval-required`; never `not-applicable`.
2. **Deny overrides allow.** Allows OR together; any matching deny wins.
3. **No string keys in the public API.** Permissions are references (`permissions.post.update`). Strings appear only as `.key` / `.scope` on the wire, in audit, catalogs and `findPermission()`.
4. **Permission leaves are plain frozen JSON.** `{ key, resource, action, scope, meta }`; the schema lives on the resource node. Leaves must survive `JSON.stringify`, RSC props and postMessage.
5. **Identity is by `key`, never by object identity.** Two copies of the definition module, or a leaf that crossed a serialisation boundary, resolve to the same grant.
6. **Portable-first.** New condition operators must have an in-memory evaluator, a JSON form, and a Drizzle / Prisma / Kysely / RLS compilation or an explicit `portable: false` marking. Closures stay a branded escape hatch.
7. **Immutable, request-scoped instances.** `createPermDock` returns a frozen object; no module-level mutable state; no `AsyncLocalStorage` in core.
8. **No server imports in client entries.** `permdock/react`, `permdock/react-native`, `permdock/webmcp` and the `client` half of framework adapters must not import policies, closures or Node built-ins; `tests/bundle` asserts it.
9. **Boundary validation.** Data from HTTP bodies, MCP tool args, client `refresh` or model output is validated against the resource's Standard Schema before a check; trusted server rows are not.
10. **Prototype-safe, no eval.** Condition paths never traverse `__proto__` / `constructor` / `prototype`; no `eval` or `new Function` anywhere.
11. **Never emit `service_role`** in generated RLS; never trust a model-supplied subject or actor; approval `token` is bound to permission key + resource id + subject + actor.
12. **Zero runtime dependencies in `permdock` core** other than `@standard-schema/spec`. Optional peers (OTel, framework SDKs, `jose` for `permdock/jwt`) are optional.
13. **Authentication is upstream.** Core never verifies a token or a session. `permdock/jwt` and the provider `subjectFrom*` helpers verify and hand core a `Subject`; an unverifiable token becomes the anonymous subject, never a throw. Never build grants from user-editable claims (`user_metadata`); never accept a subject, actor, membership or active tenant from a CLI flag, a model argument, a request body or an unsigned header. Memberships and custom roles come only from `subjectFrom*`, `subject`, `context`, a `MembershipSource` or a `RoleSource`; a requested tenant with no matching membership is no tenant, never a default one; team ids are identifiers, never display names.
14. **Naming convention** (below) is part of the public API.
15. **The Cloud is optional.** No core path requires a network call to decide; `permdock/pdp` is the only opt-in exception. Every hosted capability (approvals, decision log, snapshot distribution) is an interface (`ApprovalStore`, `DecisionSink`, `SnapshotSource`) with an in-process default shipped in the open-source package; `permdock/cloud` is one implementation, server-only, with zero required dependencies. A store or sink never influences an outcome; a resume re-runs `decide` and recomputes the token before trusting a stored approval. `MembershipSource` and `RoleSource` are subject inputs (they may shape an outcome, like `subject` and `context`) and `permdock/cloud` never implements them. PermDock Cloud itself lives in the separate `PermDock-Cloud` repository and follows this repository's wire formats.

## Naming convention

- The brand is the noun. Type `PermDock`, instance `permdock`, factory `createPermDock`.
- Every server and agent adapter exports `createPermDock`; the import path names the framework (`permdock/next`, `permdock/hono`). Never `NextDock`, `HonoDock`, `dock`, `ability`, `can` as a definer, or `$`-prefixed members.
- React: `PermDockProvider`, `usePermDock`, `usePermission`, `<Protected>` are direct exports of `permdock/react`.
- Servers: `getPermDock` / `getPermission` are the async counterparts of `usePermDock` / `usePermission` (next-intl `use*` / `get*` duality).
- Subject providers: `subjectFrom<Source>` (`subjectFromJwt`, `subjectFromSupabase`, `subjectFromClerk`, `subjectFromBetterAuth`, `subjectFromMcp`) return a `Subject` and never throw. `permdock/jwt` also exports `createJwtSubjectResolver`.
- Terminal: `permdock/terminal` (consumers' own CLIs) returns `permdock`, `protect`, `filterCommands`, `format`. It is not `@permdock/cli`.
- Agent runtimes: `permdock/eve` returns `approval`, `approvalFor`, `permdock`; `permdock/openai` returns `needsApproval`, `guardTools`, `resolveInterruptions`, `permdock`. Every agent and HTTP adapter accepts `store` (an `ApprovalStore`), `sink` (a `DecisionSink`) and `snapshots` (a `SnapshotSource`).
- Approvals: `permdock/approvals` exports `ApprovalStore`, `ApprovalRequest`, `memoryApprovalStore`, `approvalsHandler`. The HTTP resume header is `PermDock-Approval`. Core exports `DecisionSink` and `memorySink`.
- Cloud: `permdock/cloud` exports `cloud({ url, key })` returning `approvals`, `sink`, `snapshots`; env vars `PERMDOCK_CLOUD_URL`, `PERMDOCK_CLOUD_KEY` (server-only). The product is "PermDock Cloud"; the embedded engine is a "PDP", the hosted endpoint an "ADS". Never `@permdock/cloud` as a package.
- Definitions: `definePermissions`, `resource` (with `parent`), `mergePermissions`, `listPermissions`, `findPermission`. Policy: `definePolicy` (with `scopes`), `role` (options `on`, `assignable`), `allow`, `deny` (a reference or an array of references), `subject`. Never a fluent policy builder.
- Tenancy (ADR 0024): `Membership`, `CustomRole`, `principal.memberships`, `principal.tenant`; the condition node is `memberOf`; interfaces `RoleSource` (`rolesFor`, `assignable`) and `MembershipSource` (`membershipsFor`) with `memoryRoleSource` in the package; adapter options `memberships` and `customRoles`; reasons `tenant-mismatch`, `no-membership`, `scope`, `expired-membership`.
- Instance methods: `can`, `decide`, `assert`, `filter`, `where`, `simulate`, `snapshot`, `on`, plus `tenant(id)` and `team(id)` (derived frozen instances) and the read-only `memberships()`, `tenants()`, `roles({ tenant })`, `assignable()`, `subscribe()` on the client.
- Providers and extension: every `subjectFrom*` satisfies `SubjectResolver<TInput, TPrincipal>`; each provider entry exports a base principal type (`SupabasePrincipal`, `ClerkPrincipal`, `BetterAuthPrincipal`, `JwtPrincipal`, `McpPrincipal`) and a `schema` option (any Standard Schema) that validates and types custom claims; a provider that stores roles exports `<provider>RoleSource` (`betterAuthRoleSource`); `PrincipalOf<typeof policy>` and `SubjectOf<typeof policy>` are the helper types. Never `declare module` augmentation or a `$Infer` accessor. Extension interfaces (`SubjectResolver`, `MembershipSource`, `RoleSource`, `ApprovalStore`, `DecisionSink`, `SnapshotSource`, `LimitStore`, `WhereCompiler`) are documented on `concepts/extension-interfaces.mdx` with conformance runners `test<Interface>` in `@permdock/testing`.
- UI hooks (`permdock/react`, mirrored by `permdock/react-native`, `vue`, `svelte`, `solid`): `useTenant`, `useMemberships`, `useRoles`, `useAssignableRoles`, `usePermissions`, `useFilter`, `useApproval`, `useSubject`, the pure `describe(decision)` helper and `approvalHeaders(token)`; `<Protected>` accepts `tenant`. Never a CASL-style `<Can>`; no components beyond `<Protected>`.
- Errors: `PermDockDeniedError`, `PermDockApprovalRequiredError`, `PermDockValidationError`.
- CLI: `permdock <command>`; build hooks: `createPermDockPlugin` (Next) and `createPermDockUnplugin` (Vite, Rollup, webpack, Rspack, esbuild via unplugin), both collect only, never API wiring. `permdock openapi` flags: `--target 3.1|3.2|3.3`, `--format document|overlay`, `--check`, `--profile fapi2`.
- Ecosystem rule (ADR 0023): PermDock composes with spec producers (next-openapi-gen, hono-openapi, TypeSpec), appliers (next-openapi-gen, Redocly CLI, Bump.sh, Speakeasy, `overlays-js`), SDK generators (Hey API, Orval, Kubb), docs UIs and hosts (Scalar, Mintlify, Bump.sh, Fern), OpenAPI-to-MCP bridges, MCP hosts (`mcp-handler`), auth providers with JWKS, agent frameworks without a hook, approval delivery surfaces (Vercel Chat SDK), sinks and flag SDKs through wire formats and recipes. No `permdock/hey-api`, `permdock/scalar`, `permdock/next-openapi-gen`, `permdock/mintlify`, `permdock/chat` or per-provider packages beyond the planned adapter list. Never write `x-scalar-*`, `x-stainless-*`, `x-readme`, `x-mint`, `x-mcp`, `x-topics`, `x-fern-*`, `x-speakeasy-*` or gateway import namespaces (`x-amazon-apigateway-*`, `x-google-*`, `x-kong-*`, `x-zuplo-*`); `x-badges` is the one opt-in rendering hint outside `x-permdock-*` and the registered set. Every third-party tool named anywhere in the docs has a row in `research/ecosystem-index.mdx`.
- OpenAPI extensions: `x-permdock-*` only (namespace registration is a Phase 2 task); `x-oai-*` names only when they exist in the OAI extension registry (`x-oai-deprecated`, `x-oai-deviceAuthorization`, `x-oai-deviceAuthorizationUrl`).

Details and rationale: `apps/docs/content/docs/getting-started/naming.mdx`, `decisions/0005-naming-convention.mdx`.

## Docs conventions (`apps/docs/content/docs`)

- Fumadocs-ready MDX: frontmatter `title` + `description`, no `# h1`, plain Markdown bodies, fenced code with language tags, ```mermaid fences. No Fumadocs components or imports until `apps/docs` is scaffolded.
- Every folder has `meta.json` with `title` and an explicit `pages` order (`---Section---` separators allowed); root `meta.json` has `root: true`. Adding a page means adding it to `meta.json`.
- Links between pages are `/docs/<path>` URLs, never `.mdx` file paths. `README.md` and `PRODUCT.md`, which render on GitHub, link to the `.mdx` files directly.
- One page per adapter (`adapters/<name>.mdx`) and per standard (`standards/<name>.mdx`), each with `Status: planned | in progress | shipped` and `Phase: n` lines directly under the frontmatter. Standards pages PermDock follows but has no adapter for yet use `Status: tracking`. A standards page's `Phase` is the first phase PermDock uses the standard; adapter phases are listed in-page. Update `Status` in the same PR that ships the code.
- Decisions are ADRs in `decisions/NNNN-slug.mdx` (Status, Context, Decision, Consequences, Alternatives considered, Related). Append-only; supersede, do not delete. Next number: 0025.
- Research pages end with Adopt / adapt / avoid and Decisions informed.
- No `{`, `}` or bare `<` in prose (MDX parses them); use backticks.

## When you change X, also update Y

| Change | Also update |
| --- | --- |
| Add or change an adapter entry | `adapters/<name>.mdx` (API, Status, Phase), `adapters/index.mdx` matrix, `adapters/meta.json`, the `wire-permdock` skill reference, `apps/examples/<name>`, README "Works with" table, PRODUCT matrix, `tests/bundle` measurement |
| Add a public identifier | `getting-started/naming.mdx`, the relevant `concepts/*.mdx`, the skill, `AGENTS.md` naming section, an ADR if it is a new concept |
| Change a wire format (leaf, condition, snapshot, Decision, decision event, approval request, AuthZEN mapping, Problem Details, catalog) | `concepts/wire-formats.mdx`, bump the format version, `@permdock/testing` fixtures, an ADR, and the PermDock-Cloud repository (it reads these formats) |
| Change the Cloud HTTP API or the `ApprovalStore` / `DecisionSink` / `SnapshotSource` interfaces | `adapters/cloud.mdx`, `adapters/approvals.mdx`, `concepts/audit-and-observability.mdx`, `concepts/wire-formats.mdx`, `security/threat-model.mdx` Cloud rows, the PermDock-Cloud repository |
| Add an agent-runtime adapter | `adapters/<name>.mdx` with the outcome mapping table, `security/approvals.mdx` surfaces table, `adapters/index.mdx` denial table, `apps/examples/<name>-agent`, `research/agent-standards-2026.mdx` if the runtime's hook is new |
| Add a condition operator | in-memory evaluator, JSON schema, Drizzle / Prisma / Kysely / RLS compilers (or explicit non-portable marking), `concepts/conditions.mdx`, `adapters/rls.mdx` portable-subset table |
| Add a scope kind, membership source, role source or provider membership mapping | `concepts/tenancy.mdx`, `concepts/extension-interfaces.mdx`, the provider page "Memberships" section, `concepts/authentication.mdx` source table, `adapters/rls.mdx` membership table mapping, `@permdock/testing` policy matrix and conformance runner, `security/threat-model.mdx` tenant rows |
| Add a UI hook, composable or store | `concepts/ui.mdx`, every UI adapter page (`react`, `react-native`, `vue`, `svelte`, `solid`), the parity table on `adapters/index.mdx`, `getting-started/naming.mdx` |
| Add a CLI command or flag | `cli/<command>.mdx`, `cli/index.mdx` table, `permdock doctor` if it is a check, the skill |
| Name a third-party tool PermDock composes with (producer, applier, generator, docs host, bridge, MCP host, provider, framework, delivery surface, sink, flag SDK, database) | A row in `research/ecosystem-index.mdx` (mandatory, same PR); the `research/openapi-ecosystem.mdx`, `research/commercial-landscape.mdx`, `research/agent-frameworks.mdx` or `research/local-first-sync.mdx` matrix; the adapter or concept page carrying the recipe; `standards/watch-list.mdx` if it is a specification; never a new package entry without an ADR |
| Change the OpenAPI Overlay shape or the `x-badges` hint | `standards/openapi-overlay.mdx`, `adapters/openapi.mdx`, `cli/openapi.mdx`, `adapters/next.mdx` recipe, the lint ruleset file, `@permdock/testing` fixtures |
| Add or bump a standard | `standards/<name>.mdx`, `standards/index.mdx` table (including the Maturity column), `standards/watch-list.mdx` row, the adapter page that uses it, `security/*` if it changes the threat model |
| Add a subject provider or claim mapping | `concepts/authentication.mdx` source table, the provider's adapter page "Verified material" section, `security/threat-model.mdx` token rows, `getting-started/naming.mdx` `subjectFrom*` row |
| Add an OpenAPI extension | `standards/openapi-registry.mdx` table, `standards/openapi-3-2.mdx`, `adapters/openapi.mdx`, `cli/openapi.mdx`, the registry PR once the namespace is registered |
| Change a security default | `security/threat-model.mdx`, `security/owasp-agentic.mdx` mapping, README "Secure by default" bullet, this file's invariants |
| Add an example app | `apps/examples/<name>`, its adapter page "Example app" section, `tests/e2e`, README table |
| Change the roadmap or phases | `roadmap.mdx`, PRODUCT.md roadmap and matrix, `Phase` lines on affected adapter / standards pages |
| Resolve an open question | new ADR, remove it from `roadmap.mdx` and PRODUCT.md, update the pages that listed it under "Open questions" |

## Consumer skills vs this guide

- `packages/permdock/skills/wire-permdock/SKILL.md`: how to add PermDock to an app (define, policy, factory file, first guard, MCP / AI SDK wiring, `permdock doctor`). Written for the consumer's repo.
- `packages/permdock/skills/audit-permissions/SKILL.md`: how to review an existing PermDock setup (ungranted permissions, unused definitions, closures that could be portable, snapshot scope, OWASP ASI02 / ASI03 checklist).
- This file: how to change PermDock itself. Do not put consumer instructions here or maintainer instructions in the skills.

## Working style

- Small PRs, one adapter or one concept each. Public API changes start as an RFC-lite issue and end as an ADR.
- Every user-visible change has a changeset.
- Tests before features for anything touching evaluation semantics; add a case to the policy matrix in `@permdock/testing` and, for conditions, to the RLS parity suite.
- Prefer deleting an open question by deciding it over carrying it forward.
