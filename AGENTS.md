# AGENTS.md — maintainer guide for PermDock

This file is for agents and humans changing the PermDock repository. It is not the consumer skill: consumers get `wire-permdock` and `audit-permissions` from the `permdock` package (`npx skills add ScaleDockHQ/PermDock`). `CLAUDE.md` is a symlink to this file; do not fork the two.

The product plan and every design decision live in `PRODUCT.md` and `apps/docs/content/docs/`. Read `apps/docs/content/docs/index.mdx`, `getting-started/naming.mdx` and `security/threat-model.mdx` before touching code.

## Status

Phase 2 in progress. Phase 1 shipped core, adapters, skills, examples, the TS matrix, `@permdock/cli` and `tests/e2e` (Hono smoke; `instant()` waits for a bootable Next example). Phase 2 has started with `permdock/mcp`, `permdock/authzen`, `permdock/openapi`, `permdock/react-native`, `permdock/express`, `permdock/fastify`, `permdock/elysia`, `permdock/nest`, `permdock/node`, `permdock/trpc`, `permdock/orpc`, `permdock/vue`, `permdock/svelte`, `permdock/solid`, `permdock/terminal`, `permdock/webmcp`, `permdock/a2a`, `permdock/otel`, `permdock/scim` and `permdock/cloud`. Anything you add must match the layout below so later milestones do not have to move it.

The docs app is the first [Vercel Service](https://vercel.com/docs/services): root `vercel.json` sends `/docs`, `/_next`, `/api/search`, `/llms.txt`, `/llms-full.txt`, `/llms.mdx` and `/og` to `apps/docs`. Do **not** set Next.js `basePath: '/docs'` until a second Next.js service exists. MDX already links to `/docs/...`; `basePath` plus `loader({ baseUrl: '/docs' })` double-prefixes `next/link` (`/docs/docs/...`). Until then the docs service owns `/_next` and `/api/search`. A later Hono/Python/Vite service is a rewrite **above** those rules.

## Repo layout

```
packages/
  permdock/           npm `permdock` — src/core, src/conditions, one folder per subpath adapter
                      (react, react-native, next, vue, svelte, solid, server, hono, express, fastify,
                       elysia, nest, node, terminal, trpc, orpc, mcp, ai-sdk, claude-agent, eve, openai, webmcp, a2a,
                       authzen, approvals, cloud, ssf, scim, openapi, otel, drizzle, prisma, kysely, jwt, supabase,
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
  docs/               Fumadocs v16 on Next.js 16.3 (scaffolded); content in apps/docs/content/docs; first Vercel Service at `/docs`
  examples/<name>/    one app per adapter: next, react-vite, expo, vue, svelte, solid, hono, express, fastify,
                      elysia, nest, terminal, trpc, orpc, mcp-server, ai-sdk-agent, claude-agent, eve-agent,
                      openai-agent, webmcp, a2a-agent, authzen-pdp, scim, supabase-rls, drizzle, prisma, better-auth,
                      clerk, convex, monorepo
                      (eve-agent doubles as the PermDock Cloud template on the Vercel Marketplace)
tests/
  e2e/                Playwright across examples, including @next/playwright instant()
  types/              TS 5.9 / 6 / 7 matrix
  integration/        Postgres via testcontainers: RLS parity, providers
  bundle/             per-entry gzip measurements; baseline set after core ships
```

## Commands (keep these names; Phase 1 names that have no package yet will fail until that package exists)

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
15. **The Cloud is optional.** No core path requires a network call to decide; `permdock/pdp` is the only opt-in exception. Every hosted capability (approvals, decision log, snapshot distribution) is an interface (`ApprovalStore`, `DecisionSink`, `SnapshotSource`) with an in-process default shipped in the open-source package; `permdock/cloud` is one implementation, server-only, with zero required dependencies. A store or sink never influences an outcome; a resume re-runs `decide` and recomputes the token before trusting a stored approval. `MembershipSource` and `RoleSource` are subject inputs (they may shape an outcome, like `subject` and `context`) and `permdock/cloud` never implements them. The Cloud may relay SCIM provisioning into a `DirectoryStore` the application owns (`permdock/scim`), but it holds no authoritative directory copy and a Cloud outage leaves memberships at their last synced state (ADR 0027). Every Cloud connector speaks a standard wire format or an existing PermDock interface, never a per-vendor npm entry, and no connector sits on the decision path; the Cloud's MCP server is read-only and never resolves an approval. PermDock Cloud itself lives in the separate `PermDock-Cloud` repository and follows this repository's wire formats.

## Naming convention

- The brand is the noun. Type `PermDock`, instance `permdock`, factory `createPermDock`.
- Every server and agent adapter exports `createPermDock`; the import path names the framework (`permdock/next`, `permdock/hono`). Never `NextDock`, `HonoDock`, `dock`, `ability`, `can` as a definer, or `$`-prefixed members.
- React: `PermDockProvider`, `usePermDock`, `usePermission`, `<Protected>` are direct exports of `permdock/react`.
- Servers: `getPermDock` / `getPermission` are the async counterparts of `usePermDock` / `usePermission` (next-intl `use*` / `get*` duality).
- Subject providers: `subjectFrom<Source>` (`subjectFromJwt`, `subjectFromSupabase`, `subjectFromClerk`, `subjectFromBetterAuth`, `subjectFromMcp`; `subjectFromIntrospection` in Phase 4) return a `Subject` and never throw. `permdock/jwt` also exports `createJwtSubjectResolver`, `verifyDpopProof`, `joseTokenVerifier` and `joseTokenSigner`.
- JOSE and OpenID Connect (ADR 0026): core declares `TokenVerifier` (`verify(token, expectations)` returning `{ ok: true, claims, header }` or `{ ok: false, reason: 'invalid-token', cause }`) and `TokenSigner` (`sign(payload, { typ })` returning compact JWS) as types only; `permdock/jwt` implements both over the optional `jose` peer. Option names are `verifier` and `signer`; `permdock/jwt` options are `discovery` (OIDC Discovery, RFC 8414 fallback; mutually exclusive with `jwks` + `issuer`), `accept` (`'access-token'` default, `'id-token'`), `algorithms` (default `ES256`, `PS256`, `Ed25519`, plus `RS256` outside `profile: 'fapi2'`; `Ed25519` per RFC 9864, `EdDSA` accepted for `crv: Ed25519` only, never `none` or `RSA1_5`), `decryptionKeys` (JWE accepted only when set; nested JWS-in-JWE with `cty: JWT`), `sender`, `profile`. Subject fields from the specs: `principal.issuer` (`iss`), `principal.assurance.{acr, amr, authTime}`, `subject.session` (`sid`), `binding` with RFC 7800 `cnf` member names (`jkt`, `x5t#S256`, `jwk`, `kid`); `actor.kind` for `act`-derived actors is `'oauth-client'`, for MCP clients always `'mcp-client'`. Token failures are `on('auth')` events with `reason: 'invalid-token'` and a `cause` from the closed list on `adapters/jwt.mdx`; the Decision reason for a failed `subject.assurance` condition is `insufficient-user-authentication` (RFC 9470); `not-delegated` / `no-delegation` render as RFC 6750 `insufficient_scope`. Signed outputs are compact JWS with header `alg`, `kid`, `typ` only and `typ` values `permdock-snapshot+jwt`, `permdock-approval+jwt`, `permdock-decisions+jwt`; the payload sits under one private claim (`snapshot`, `approval`, `events`) next to registered claims; Snapshot v2 is unchanged inside. `permdock/cloud` publishes `/.well-known/jwks.json`. Every spec-to-PermDock name mapping lives in the "Spec names" table on `getting-started/naming.mdx`; add a row before adding a field that a specification already names.
- Terminal: `permdock/terminal` (consumers' own CLIs) returns `permdock`, `protect`, `filterCommands`, `format`, `exitCode`. It is not `@permdock/cli`.
- Agent runtimes: `permdock/eve` returns `approval`, `approvalFor`, `permdock`; `permdock/openai` returns `needsApproval`, `guardTools`, `resolveInterruptions`, `permdock`. Every agent and HTTP adapter accepts `store` (an `ApprovalStore`), `sink` (a `DecisionSink`) and `snapshots` (a `SnapshotSource`).
- Approvals: `permdock/approvals` exports `ApprovalStore`, `ApprovalRequest`, `memoryApprovalStore`, `approvalsHandler`. The HTTP resume header is `PermDock-Approval`. Core exports `DecisionSink`, `memorySink` (`signer` option) and `signDecisionBatch`.
- Snapshots: `parseSnapshot(json)` reads snapshot v2; it rejects unknown majors and forbidden keys. `fromSnapshot(snapshot)` builds the client `PermDock`. `permdock.snapshot()` ships full grants; `tenants: 'all'` is opt-in ([0031](apps/docs/content/docs/decisions/0031-snapshot-contents.mdx)).
- Denial reasons: an undeclared role is `unknown-role`; a boundary failure is `validation` (not `invalid-resource`).
- Directory (ADR 0027): `permdock/scim` has no `createPermDock`; it exports `scimHandler({ store, tenant, token | verifier, groupRoles, sink, onChange })` (RFC 7644 `/Users` and `/Groups`, RFC 9865 cursor pagination), the `DirectoryStore` interface with `memoryDirectoryStore()`, and `directoryMembershipSource(store)` (a `MembershipSource`; `team` is the group `id`, `via: 'group:<id>'`, no memberships for `active: false`). The group-to-role extension is `urn:permdock:scim:schemas:extension:roles:1.0`; unknown or non-`assignable` role names are dropped. The tenant is bound to the credential, never read from a body. Directory events are `directory` events on the sink; the CloudEvents types are `dev.permdock.decision`, `dev.permdock.approval`, `dev.permdock.directory`, `dev.permdock.catalog`. Cloud integrations are documented on `adapters/cloud-integrations.mdx`, never as packages.
- Cloud: `permdock/cloud` exports `cloud({ url, key })` returning `approvals`, `sink`, `snapshots`; env vars `PERMDOCK_CLOUD_URL`, `PERMDOCK_CLOUD_KEY` (server-only). The product is "PermDock Cloud"; the embedded engine is a "PDP", the hosted endpoint an "ADS". Never `@permdock/cloud` as a package.
- Definitions: `definePermissions`, `resource` (with `parent`), `crud` / `readable` / `writable` (option factories for `resource()`, never constructors or grants), `mergePermissions`, `listPermissions`, `findPermission`. Policy: `definePolicy` (with `scopes`), `role` (options `on`, `assignable`), `allow`, `deny` (a reference or an array of references), `subject`. Never a fluent policy builder.
- Tenancy (ADR 0024): `Membership`, `CustomRole`, `principal.memberships`, `principal.tenant`; the condition node is `memberOf`; interfaces `RoleSource` (`rolesFor`, `assignable`) and `MembershipSource` (`membershipsFor`) with `memoryRoleSource` in the package; adapter options `memberships` and `customRoles`; reasons `tenant-mismatch`, `no-membership`, `scope`, `expired-membership`.
- Instance methods: `can`, `decide`, `assert`, `filter`, `where`, `simulate`, `snapshot`, `on`, plus `tenant(id)` and `team(id)` (derived frozen instances) and the read-only `memberships()`, `tenants()`, `roles({ tenant })`, `assignable()`, `subscribe()` on the client.
- Providers and extension: every `subjectFrom*` satisfies `SubjectResolver<TInput, TPrincipal>`; each provider entry exports a base principal type (`SupabasePrincipal`, `ClerkPrincipal`, `BetterAuthPrincipal`, `JwtPrincipal`, `McpPrincipal`) and a `schema` option (any Standard Schema) that validates and types custom claims; a provider that stores roles exports `<provider>RoleSource` (`betterAuthRoleSource`); `PrincipalOf<typeof policy>` and `SubjectOf<typeof policy>` are the helper types. Never `declare module` augmentation or a `$Infer` accessor. Extension interfaces (`SubjectResolver`, `TokenVerifier`, `TokenSigner`, `MembershipSource`, `RoleSource`, `ApprovalStore`, `DecisionSink`, `SnapshotSource`, `LimitStore`, `WhereCompiler`) are documented on `concepts/extension-interfaces.mdx` with conformance runners `test<Interface>` in `@permdock/testing`.
- UI hooks (`permdock/react`, mirrored by `permdock/react-native`, `vue`, `svelte`, `solid`): `useTenant`, `useMemberships`, `useRoles`, `useAssignableRoles`, `usePermissions`, `useFilter`, `useApproval`, `useSubject`, the pure `describe(decision)` helper and `approvalHeaders(token)`; `<Protected>` accepts `tenant`. Never a CASL-style `<Can>`; no components beyond `<Protected>`.
- Errors: `PermDockDeniedError`, `PermDockApprovalRequiredError`, `PermDockValidationError`.
- CLI: `permdock <command>`; build hooks: `createPermDockPlugin` (Next) and `createPermDockUnplugin` (Vite, Rollup, webpack, Rspack, esbuild via unplugin), both collect only, never API wiring. `permdock openapi` flags: `--target 3.1|3.2|3.3`, `--format document|overlay`, `--overlay 1.1|1.2`, `--check`, `--profile fapi2`, `--profile-scheme`. `--overlay 1.2` (adapter `overlay({ version: '1.2' })`) is experimental and emits the pinned Overlay 1.2 draft: `overlay: 1.2.0`, one Reusable Action Object under `components.actions` per distinct permission set (key: sorted comma-joined permission keys, RFC 6901-escaped in `$ref`), one `$ref` reference per operation carrying only `$ref`, `target`, `description`; the pin is `x-permdock-catalog.drafts.overlay`; `1.1` stays the default until 1.2.0 ships and the documented appliers accept `components.actions`; never emit `targetFormat`. `--target 3.3` is experimental and emits the pinned OpenAPI 3.3 Security Profile draft (a `type: profile` scheme whose `profileMetadata.name` comes from a fixed map, `fapi2` to `fapi-20-security-profile`, plus `components.securityProfileRequirements`) always next to its `x-permdock-securityProfile` twin, with the pin in `x-permdock-catalog.drafts`; it switches to the released construct at 3.3.0 (ADR 0025). `scheme.type: 'gnap'` is reserved and emits nothing; never emit `x-gnap` or any other party's unregistered extension.
- Ecosystem rule (ADR 0023): PermDock composes with spec producers (next-openapi-gen, hono-openapi, TypeSpec), appliers (next-openapi-gen, Redocly CLI, Bump.sh, Speakeasy, `overlays-js`), SDK generators (Hey API, Orval, Kubb), docs UIs and hosts (Scalar, Mintlify, Bump.sh, Fern), OpenAPI-to-MCP bridges, MCP hosts (`mcp-handler`), auth providers with JWKS, agent frameworks without a hook, approval delivery surfaces (Vercel Chat SDK), sinks and flag SDKs through wire formats and recipes. No `permdock/hey-api`, `permdock/scalar`, `permdock/next-openapi-gen`, `permdock/mintlify`, `permdock/chat` or per-provider packages beyond the planned adapter list. Never write `x-scalar-*`, `x-stainless-*`, `x-readme`, `x-mint`, `x-mcp`, `x-topics`, `x-fern-*`, `x-speakeasy-*` or gateway import namespaces (`x-amazon-apigateway-*`, `x-google-*`, `x-kong-*`, `x-zuplo-*`); `x-badges` is the one opt-in rendering hint outside `x-permdock-*` and the registered set. Every third-party tool named anywhere in the docs has a row in `research/ecosystem-index.mdx`.
- OpenAPI extensions: `x-permdock-*` only (namespace registration is a Phase 2 task); `x-oai-*` names only when they exist in the OAI extension registry (`x-oai-deprecated`, `x-oai-deviceAuthorization`, `x-oai-deviceAuthorizationUrl`).

Details and rationale: `apps/docs/content/docs/getting-started/naming.mdx`, `decisions/0005-naming-convention.mdx`.

## Docs conventions (`apps/docs/content/docs`)

- Fumadocs-ready MDX: frontmatter `title` + `description`, no `# h1`, plain Markdown bodies, fenced code with language tags, ```mermaid fences. No Fumadocs components or imports until `apps/docs` is scaffolded.
- Every folder has `meta.json` with `title` and an explicit `pages` order (`---Section---` separators allowed); root `meta.json` has `root: true`. Adding a page means adding it to `meta.json`.
- Links between pages are `/docs/<path>` URLs, never `.mdx` file paths. `README.md` and `PRODUCT.md`, which render on GitHub, link to the `.mdx` files directly.
- One page per adapter (`adapters/<name>.mdx`) and per standard (`standards/<name>.mdx`), each with `Status: planned | in progress | shipped` and `Phase: n` lines directly under the frontmatter. Standards pages PermDock follows but has no adapter for yet use `Status: tracking`. A standards page for an unfinished text adds `Draft posture: build | name | track` as a third line (ADR 0025): `build` names the pinned revision in the same line and means PermDock implements that revision with a stable twin; `name` means only identifiers are reserved; `track` means no code and no names. The watch list carries the same value in its Posture column; finished specifications carry none. A standards page's `Phase` is the first phase PermDock uses the standard; adapter phases are listed in-page. Update `Status` in the same PR that ships the code.
- Decisions are ADRs in `decisions/NNNN-slug.mdx` (Status, Context, Decision, Consequences, Alternatives considered, Related). Append-only; supersede, do not delete. Next number: 0033.
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
| Add a directory source, a SCIM attribute or extension, or change the `DirectoryStore` interface | `adapters/scim.mdx`, `standards/scim.mdx` attribute table, `concepts/extension-interfaces.mdx` `DirectoryStore` section and `testDirectoryStore` runner, `concepts/authentication.mdx` diagram and Lifecycle, `getting-started/naming.mdx` Spec names, `security/threat-model.mdx` SCIM rows, the PermDock-Cloud repository (the relay replays it) |
| Add a Cloud connector, a CloudEvents `type` or an evidence export format | `adapters/cloud-integrations.mdx` table for its direction (Connector, Standard or interface, What it carries, Never), `concepts/wire-formats.mdx` CloudEvents types, `concepts/audit-and-observability.mdx` Evidence and governance, `research/ecosystem-index.mdx` row per named destination, `security/threat-model.mdx` Cloud rows, the PermDock-Cloud repository; never a new package entry |
| Add a UI hook, composable or store | `concepts/ui.mdx`, every UI adapter page (`react`, `react-native`, `vue`, `svelte`, `solid`), the parity table on `adapters/index.mdx`, `getting-started/naming.mdx` |
| Add a CLI command or flag | `cli/<command>.mdx`, `cli/index.mdx` table, `permdock doctor` if it is a check, the skill |
| Name a third-party tool PermDock composes with (producer, applier, generator, docs host, bridge, MCP host, provider, framework, delivery surface, sink, flag SDK, database) | A row in `research/ecosystem-index.mdx` (mandatory, same PR); the `research/openapi-ecosystem.mdx`, `research/commercial-landscape.mdx`, `research/agent-frameworks.mdx` or `research/local-first-sync.mdx` matrix; the adapter or concept page carrying the recipe; `standards/watch-list.mdx` if it is a specification; never a new package entry without an ADR |
| Change the OpenAPI Overlay shape or the `x-badges` hint | `standards/openapi-overlay.mdx`, `adapters/openapi.mdx`, `cli/openapi.mdx`, `adapters/next.mdx` recipe, the lint ruleset file, `@permdock/testing` fixtures |
| Add or bump a standard | `standards/<name>.mdx`, `standards/index.mdx` table (including the Maturity column), `standards/watch-list.mdx` row, the adapter page that uses it, `security/*` if it changes the threat model |
| Add a subject provider or claim mapping | `concepts/authentication.mdx` source table, the provider's adapter page "Verified material" section, `security/threat-model.mdx` token rows, `getting-started/naming.mdx` `subjectFrom*` row and "Spec names" table, `standards/openid-connect.mdx` claim table if the claim is an OIDC claim, `concepts/subject.mdx` |
| Add a signed output, a `typ` value or a JWS header parameter | `standards/jose.mdx` produce table, `concepts/wire-formats.mdx` "Signed outputs", `standards/openapi-registry.mdx` `typ` table, the `TokenSigner` section on `concepts/extension-interfaces.mdx`, `@permdock/testing` JWS fixtures, `security/threat-model.mdx` signed-output rows |
| Add an `on('auth')` `cause` or a token-verification default (algorithm, `typ`, JWE) | `adapters/jwt.mdx` cause table and defaults, `standards/jose.mdx` checklist, `standards/fapi-2.mdx` if the profile tightens it, `cli/doctor.mdx` if it is a check, `security/threat-model.mdx` token rows |
| Add an OpenAPI extension | `standards/openapi-registry.mdx` table, `standards/openapi-3-2.mdx`, `adapters/openapi.mdx`, `cli/openapi.mdx`, the registry PR once the namespace is registered |
| Bump a pinned draft revision (OpenAPI 3.3 Security Profiles, Overlay 1.2, WebMCP, RAR remediation, OpenTelemetry GenAI, Web Bot Auth) or change a draft's posture | The standards page `Draft posture` line, `standards/watch-list.mdx` Posture cell, `x-permdock-catalog.drafts` for document and Overlay output, the emitter's name map and patch schema, `@permdock/testing` fixtures keyed by the pin, a changeset; a posture change also needs an ADR |
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
