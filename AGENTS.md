# AGENTS.md — maintainer guide for PermDock

This file is for agents and humans changing the PermDock repository. It is not the consumer skill: consumers get `wire-permdock` and `audit-permissions` from the `permdock` package (`npx skills add ScaleDockHQ/PermDock`). `CLAUDE.md` is the one line `@AGENTS.md` (a Claude Code import) so tools that read both names load this file once; put everything here, never in `CLAUDE.md`.

`PRODUCT.md` is the short product brief. Every design decision and its rationale lives in `apps/docs/content/docs/`, in the `Why` section of the page that owns it. Read `apps/docs/content/docs/index.mdx`, `getting-started/naming.mdx` and `security/threat-model.mdx` before touching code.

## Status

Pre-release. Everything in this repo is the 0.1.0 baseline; nothing has shipped, so there is no compatibility to keep: change a name or format in place. Package versions sit at `0.0.0` with one changeset, so the first release is `0.1.0`, and every wire format is `v1` (snapshot `v: 1`, approval request `v: 1`, `catalog-v1.json` with `version: 1`). Scenario testing covers the shared SaaS domain in `permdock/testing/saas`, the `testClientParity`, `testClientStore`, `testHttpAdapter` and `ormParity` runners, fixture apps under `tests/e2e/fixtures`, and `tests/runtimes` on Node, Bun, Deno and workerd ([guide](apps/docs/content/docs/guides/scenario-testing.mdx)). Anything you add must match the layout below.

The marketing app (`apps/marketing`) is the second [Vercel Service](https://vercel.com/docs/services): it owns `/`, `/_next`, `robots.txt` and `sitemap.xml`. The docs app keeps `/docs`, `/api/search`, `/mcp`, `/devtools`, `/llms.txt`, `/llms-full.txt`, `/llms.mdx` and `/og`, with `assetPrefix: '/docs'` so its assets ride `/docs/_next` (never `basePath: '/docs'`, which double-prefixes `next/link`). Both services compile `permdock` with `node --run build` then `next build`: `dist/` is not committed, and Vercel's bundled pnpm fails the `packageManager` 12.6.0 check. The `/mcp` route is the public docs MCP server (search and page-fetch only; no subject). PermDock Cloud is a separate Vercel project: dashboard `https://app.permdock.com`, API `https://api.permdock.com`, read-only MCP `https://mcp.permdock.com`.

## Repo layout

```
packages/
  permdock/           npm `permdock` (the only published package, owned by the `scaledockhq` npm org) — src/core, src/conditions, one folder per subpath adapter
                      (react, react-native, next, vue, svelte, solid, server, hono, express, fastify,
                       elysia, nest, node, terminal, trpc, orpc, mcp, ai-sdk, claude-agent, eve, openai, webmcp, a2a,
                       authzen, approvals, cloud, ssf, scim, openapi, otel, drizzle, prisma, kysely, jwt, supabase,
                       supabase/middleware, better-auth, clerk, convex, pdp)
                      src/testing: `permdock/testing` — policy matrix tests, snapshot fixtures, RLS parity runner,
                      conformance runners, client parity and HTTP adapter scenario runners, the shared SaaS domain
                      (`permdock/testing/saas`); Vitest is an optional peer
                      src/cli: the `permdock` bin — collect, catalog, usage, openapi, rls, doctor, skills, cloud,
                      arazzo — and `permdock/cli` (defineConfig, run); each command is loaded on demand;
                      src/next/plugin.ts and src/unplugin: `permdock/next/plugin` (createPermDockPlugin) and
                      `permdock/unplugin` (createPermDockUnplugin for Vite / Rollup / webpack / Rspack / esbuild),
                      both build-time collect only
                      schemas/ (catalog and OpenAPI JSON Schemas), rulesets/ (Spectral / Redocly / vacuum ruleset
                      for `permdock openapi` invariants), skills/ (wire-permdock, audit-permissions)
  typescript-config/  private `@permdock/typescript-config` — tsconfig presets every workspace extends:
                      base.json, library.json (tsdown packages), react-library.json, next.json
  ox-config/          private `@permdock/ox-config` — `oxlint` (`base`, `ignorePatterns`) and `oxfmt` (`oxfmt()` factory);
                      the root oxlint.config.ts / oxfmt.config.ts only add repo-specific ignores, `typeAware` and the packages/** override
apps/
  marketing/          Next.js 16.3 marketing site; Vercel Service at `/`
  docs/               Fumadocs v16 on Next.js 16.3; content in apps/docs/content/docs; Vercel Service at `/docs`
  examples/<name>/    one app per adapter: next, react-vite, expo, vue, svelte, solid, hono, express, fastify,
                      elysia, nest, terminal, trpc, orpc, mcp-server, ai-sdk-agent, claude-agent, eve-agent,
                      openai-agent, webmcp, a2a-agent, authzen-pdp, scim, supabase-rls, supabase-middleware, drizzle,
                      prisma, better-auth, clerk, convex, monorepo
                      (eve-agent doubles as the PermDock Cloud template on the Vercel Marketplace)
tests/
  e2e/                Playwright across examples (web smoke per example; the `next-saas` fixture also asserts instant navigation with `@next/playwright` `instant()`)
    fixtures/<name>/  scenario apps over the `permdock/testing/saas` domain: next-saas, sveltekit-saas,
                      nuxt-saas, tanstack-start-saas, solidstart-saas, expo-saas, mcp-oauth, ai-chat,
                      realtime-collab, turborepo (its apps/* and packages/* are workspace globs), b2b-scim;
                      each has scripts/serve.ts, test-only /api/test routes and one numbered serial spec in
                      e2e/src; saas-kit holds the shared session, store and routes
  types/              TS 5.9 / 6 / 7 matrix
  integration/        Postgres via testcontainers: RLS parity, providers
  runtimes/           one WinterTC app (kernel, Hono, AuthZEN, JWT) under Bun, Deno and workerd (Miniflare), plus Elysia on Bun
  bundle/             per-entry gzip measurements and the regression baseline
```

## Commands (keep these names)

```bash
pnpm install
pnpm build                 # turbo run build (tsdown)
pnpm test                  # vitest unit + type tests
pnpm test:e2e              # playwright across apps/examples
pnpm test:integration      # testcontainers Postgres
pnpm test:runtimes         # Bun (on PATH), Deno and workerd from devDependencies; CI requires all three
pnpm lint && pnpm fmt      # oxlint, oxfmt (root scripts, whole repo; config comes from packages/ox-config)
pnpm typecheck             # turbo run typecheck (tsc --noEmit per package, presets from packages/typescript-config)
pnpm check                 # fmt:check + lint + typecheck; what CI and the pre-push hook run
pnpm check:publish         # publint + arethetypeswrong on every package
pnpm size                  # per-entry gzip measurements
pnpm docs:dev              # apps/docs on :3001
pnpm marketing:dev         # apps/marketing on :3000, proxies /docs to docs
pnpm exec permdock collect --check --cwd tests/integration/fixtures/posts
pnpm exec permdock collect --check --cwd apps/examples/monorepo
pnpm exec permdock collect --check --cwd tests/e2e/fixtures/turborepo
# catalog drift (CI); the repo root has no permdock.config.ts.
pnpm changeset             # every user-visible change
```

## Invariants (a PR that breaks one is wrong, whatever else it does)

1. **Fail-closed.** No grant, unknown role, invalid boundary data, unrecognised remote decision, thrown closure, an `actor` with no `delegation`: all deny. `can()` never throws. `Decision.outcome` is only `granted`, `denied` or `approval-required`; never `not-applicable`.
2. **Deny overrides allow.** Allows OR together; any matching deny wins.
3. **No string keys in the public API.** Permissions are references (`permissions.post.update`). Strings appear only as `.key` / `.scope` on the wire, in audit, catalogs and `findPermission()`.
4. **Permission leaves are plain frozen JSON.** `{ key, resource, action, scope, meta }`; the schema lives on the resource node. Leaves must survive `JSON.stringify`, RSC props and postMessage.
5. **Identity is by `key`, never by object identity.** Two copies of the definition module, or a leaf that crossed a serialisation boundary, resolve to the same grant.
6. **Portable-first.** New condition operators must have an in-memory evaluator, a JSON form, and a Drizzle / Prisma / Kysely / RLS compilation or an explicit `portable: false` marking. Closures stay a branded escape hatch.
7. **Immutable, request-scoped instances.** `createPermDock` returns a frozen object; no module-level mutable state; no `AsyncLocalStorage` in core.
8. **No server imports in client entries.** `permdock/react`, `permdock/react-native`, `permdock/webmcp` and the `client` half of framework adapters must not import policies, closures or Node built-ins; `tests/bundle` asserts it.
9. **Boundary validation.** Data from HTTP bodies, MCP tool args, client `refresh` or model output is validated against the resource's Standard Schema before a check; trusted server rows are not.
10. **Prototype-safe, no eval.** Condition paths never traverse `__proto__` / `constructor` / `prototype`; no `eval` or `new Function` anywhere.
11. **Never emit `service_role`** in generated RLS; never trust a model-supplied subject or actor; approval `token` is bound to permission key + resource id + subject + actor. An approver is never the request's actor, and never its principal unless the grant sets `approval: { distinct: false }` (`distinct` defaults to `true`).
12. **Runtime entry points depend on `@standard-schema/spec` only.** `permdock`, `permdock/next`, `permdock/jwt` and every other runtime entry never import CLI or test code, so they never load a CLI dependency; framework SDKs, OTel and `jose` are optional peers. The package's only other dependency is `oxc-parser`, which the everyday commands (`collect`, `doctor`, the build hooks) need; `yaml` and `ajv` are bundled into the lazily loaded CLI chunks, and heavy or rare CLI dependencies (`pgsql-parser`, `pg`, `unplugin`) are optional peers loaded by the command that needs them, with an install hint when missing. `tests/bundle` asserts both halves.
13. **Authentication is upstream.** Core never verifies a token or a session. `permdock/jwt` and the provider `subjectFrom*` helpers verify and hand core a `Subject`; an unverifiable token becomes the anonymous subject, never a throw. Never build grants from user-editable claims (`user_metadata`); never accept a subject, actor, membership or active tenant from a CLI flag, a model argument, a request body or an unsigned header. Memberships and custom roles come only from `subjectFrom*`, `subject`, `context`, a `MembershipSource` or a `RoleSource`; a requested tenant with no matching membership is no tenant, never a default one; team ids are identifiers, never display names.
14. **Naming convention** (below) is part of the public API.
15. **The Cloud is optional.** No core path requires a network call to decide; `permdock/pdp` is the only opt-in exception. Every hosted capability (approvals, decision log, snapshot distribution) is an interface (`ApprovalStore`, `DecisionSink`, `SnapshotSource`) with an in-process default shipped in the open-source package; `permdock/cloud` is one implementation, server-only, with zero required dependencies. A store or sink never influences an outcome; a resume re-runs `decide` and recomputes the token before trusting a stored approval. `MembershipSource` and `RoleSource` are subject inputs (they may shape an outcome, like `subject` and `context`) and `permdock/cloud` never implements them. The Cloud may relay SCIM provisioning into a `DirectoryStore` the application owns (`permdock/scim`); in that bring-your-own mode it holds no authoritative directory copy and a Cloud outage leaves memberships at their last synced state. Only in Cloud-native directory mode may the Cloud hold the directory of record, and then it reaches `decide` solely as claims on a token the application verifies locally; no request-time call to the Cloud ever feeds a subject. Hosted grants reach an instance only through a `PolicySource` whose `current()` is read once by `createPermDock`, apply only to permissions the policy marks `hostable`, and never override a code deny or a code approval. Every Cloud connector speaks a standard wire format or an existing PermDock interface, never a per-vendor npm entry, and no connector sits on the decision path; the Cloud's MCP server is read-only and never resolves an approval. PermDock Cloud itself lives in the separate `PermDock-Cloud` repository and follows this repository's wire formats.

## Naming convention

The names below are rules. The full inventory of exports, options, flags and reasons is on the pages in the table at the end of this section; read the owning page before adding or renaming a public identifier, option, flag, reason or wire field.

- The brand is the noun. Type `PermDock`, instance `permdock`, factory `createPermDock`. Every server and agent adapter exports `createPermDock`; the import path names the framework (`permdock/next`, `permdock/hono`). Never `NextDock`, `HonoDock`, `dock`, `ability`, `can` as a definer, or `$`-prefixed members.
- UI: `permdock/react` exports `PermDockProvider`, `usePermDock`, `usePermission`, `<Protected>` and the `use*` hooks; servers use the async `getPermDock` / `getPermission`. Vue uses `use*` composables, Svelte `setPermDock` / `getPermDock` plus readable stores, Solid accessors. Never a CASL-style `<Can>`; no components beyond `<Protected>` and, in `permdock/next/client`, the `<PermissionBoundary>` error boundary (with `usePermissionBoundary`), which renders a fallback for a thrown PermDock error and never gates. `PermDockDeniedError` and `PermDockApprovalRequiredError` carry a stable `digest` (`PERMDOCK_DENIED;<permission>`, `PERMDOCK_APPROVAL_REQUIRED;<permission>;<token>`), read with `parsePermDockDigest`.
- Subjects: every provider is `subjectFrom<Source>`, satisfies `SubjectResolver`, returns a `Subject` and never throws; each exports a `<Provider>Principal` type and a `schema` option. Types come from `PrincipalOf` / `SubjectOf`; never `declare module` augmentation or a `$Infer` accessor.
- Scopes: `definePolicy({ scopes })` declares named scopes in order, each `{ key, within? }`, one tree rooted at the first; `tenant` / `team` alias the first two. A `Membership` is `{ scope, id, within }` or `{ on }`; a role applies only at its own scope (no cascade), and RLS helpers are `permitted_<scope>_ids`. Never a hard-coded tenant/team kind in new code.
- Links: a share link is a `Capability` (v1) signed as `permdock-capability+jwt` by `signCapability` and resolved by `subjectFromCapability` into a `kind: 'link'` principal with one `{ on, roles, via: 'link' }` membership; it never holds a scope or global role. `holder: 'key'` is reserved. RLS reaches links only through `exchangeCapability` (a short-lived `anon` token, never `service_role`, no `sub`) and `permdock_capability_ids` under `--capabilities` ([link capabilities](apps/docs/content/docs/concepts/capabilities.mdx)).
- Options, not exports: `webBotAuth`, `store` (`ApprovalStore`), `sink` (`DecisionSink`), `snapshots` (`SnapshotSource`), `policies` (`PolicySource`), `verifier`, `signer`, `memberships`, `customRoles`, `limits`. Every store, sink and source interface has an in-package `memory*` default; every extension interface has a `test<Interface>` runner in `permdock/testing`.
- Definitions and policy: `definePermissions`, `resource`, `definePolicy`, `role`, `allow`, `deny` and the other plain functions on `concepts/policies.mdx`; `crud` / `readable` / `writable` are option factories for `resource()`. Never a fluent policy builder.
- Errors: `PermDockDeniedError`, `PermDockApprovalRequiredError`, `PermDockValidationError`; Web Bot Auth failures throw `InvalidSignatureError` and never become an anonymous actor.
- Denial reasons are a closed list (`concepts/decisions.mdx`). A boundary failure is `validation`, never `invalid-resource`; an undeclared role is `unknown-role`.
- Never `SnapshotV2` (the major is the `v` field), never `@permdock/cloud` (it is the `permdock/cloud` entry), never a per-vendor entry such as `permdock/hey-api`, `permdock/scalar`, `permdock/mintlify` or `permdock/chat` ([adapters](apps/docs/content/docs/adapters/index.mdx)). `with*` belongs to the Supabase middleware pipeline only. `permdock/terminal` is for consumers' CLIs and is not the `permdock` binary or `permdock/cli`; never a scoped `@permdock/*` package (`permdock`, owned by the `scaledockhq` npm organisation, is the only published name); the build hooks `createPermDockPlugin` / `createPermDockUnplugin` collect only.
- OpenAPI output: only `x-permdock-*`, registered `x-oai-*` names, and the opt-in `x-badges` hint. Never another party's namespace (`x-scalar-*`, `x-speakeasy-*`, `x-fern-*`, `x-gnap`, gateway namespaces such as `x-amazon-apigateway-*`) and never `targetFormat`. Draft constructs (OpenAPI 3.3 profiles, Overlay 1.2) always ship next to a stable twin with the pin in `x-permdock-catalog.drafts`.
- A field a specification already names keeps the spec's name; add a row to the "Spec names" table on `getting-started/naming.mdx` before adding it.
- Approvals refuse the requester: `distinct` defaults to `true`, `distinct: false` is the per-grant opt-out (doctor PD024), and `requireDistinctApprover` is a handler-wide floor over it. Never an `allowSelf` flag.
- Approvals resume one call: `ApprovalStore.consume` sets `consumedAt`. The HTTP resume header is `PermDock-Approval` ([approvals](apps/docs/content/docs/adapters/approvals.mdx)).
- Snapshots: `snapshotFor` and `mayAccess` are the cache building blocks. PermDock never adds `'use cache'` or calls `headers()` / `cookies()`; `tenants: 'all'` is opt-in ([Next.js Cache Components](apps/docs/content/docs/guides/next-cache-components.mdx)).
- Custom roles: `CustomRole.grants` entries are `{ permission, effect? }` and carry no condition, approval or limit. `resolveCustomRole` is the only resolver (evaluation, `snapshot`, `snapshotFor`, `validateCustomRole`, doctor PD023); the ceiling is the code allows of declared `assignable` roles in the role's scope, never hosted grants. `assignablePermissions` / `useAssignablePermissions` sit next to `assignableRoles`; `meta.manageRoles` on a role or permission lifts the held-grant intersection ([custom roles](apps/docs/content/docs/concepts/custom-roles.mdx)).
- Ownership: role options `min`, `max`, `transferOnly`, `assigns`, `for` and `meta.audience` (`RoleMeta`); `permdock.decideRoleChange(change)` answers `granted` / `denied` with the closed reasons `last-holder`, `max-holders`, `transfer-only`, `not-assignable-by`, `self-demotion`, `not-allowed-for-membership`, `conflicting-role`, takes the actor from the instance and fails closed without `holders`; a role held through a kind outside `for` is dropped at resolution; an `assigns` graph replaces the held-grant rule for `assignableRoles` and ranks `heldRoles`; `audiences()` / `snapshot.audiences` never grant. SQL objects are `permdock_can_assign`, `permdock_holders_<scope>` and `permdock_transfer_only_<scope>_*`; doctor PD026 ([ownership](apps/docs/content/docs/concepts/ownership.mdx)).
- Streams and sockets: `connection(...)` returns a frozen `Connection`. `RevocationFeed` (`memoryRevocationFeed()`) ends or revalidates a connection and never grants. `PermDockRevokedError` is only a connection signal. An abort adds no denial reason ([streams](apps/docs/content/docs/concepts/streams.mdx)).

| Area | Owning page |
| --- | --- |
| Every public identifier, Spec names table | `getting-started/naming.mdx` |
| Instance methods, definitions, conditions | `concepts/policies.mdx`, `concepts/conditions.mdx` |
| Tenancy, named scopes, memberships, roles, ownership, limits | `concepts/scopes.mdx`, `concepts/tenancy.mdx`, `concepts/ownership.mdx`, `concepts/extension-interfaces.mdx` |
| Share links, capabilities | `concepts/capabilities.mdx`, `adapters/jwt.mdx`, `adapters/supabase.mdx` |
| Denial reasons, Decision shape | `concepts/decisions.mdx`, `concepts/wire-formats.mdx` |
| Extension interfaces and runners | `concepts/extension-interfaces.mdx` |
| JOSE, OIDC, algorithms, `on('auth')` causes | `adapters/jwt.mdx`, `standards/jose.mdx`, `concepts/subject.mdx` |
| Snapshots, signed outputs, CloudEvents types | `concepts/snapshots.mdx`, `concepts/wire-formats.mdx` |
| Approvals, SSF, SCIM, Cloud | `adapters/approvals.mdx`, `adapters/ssf.mdx`, `adapters/scim.mdx`, `adapters/cloud.mdx` |
| Cache snapshots | `concepts/snapshots.mdx`, `guides/next-cache-components.mdx` |
| Streams, sockets, revocation feed | `concepts/streams.mdx` |
| Supabase entries | `adapters/supabase.mdx` |
| Agent runtimes, terminal, Web Bot Auth | `adapters/<name>.mdx` |
| CLI commands and flags, Overlay and 3.3 output | `cli/<command>.mdx`, `standards/openapi-overlay.mdx`, `standards/openapi.mdx`, `standards/watch-list.mdx` |
| OpenAPI extensions and bans | `standards/openapi-registry.mdx`, `research/ecosystem-index.mdx`, `adapters/index.mdx` |

## Docs conventions (`apps/docs/content/docs`)

- Fumadocs-ready MDX: frontmatter `title` + `description`, no `# h1`, plain Markdown bodies, fenced code with language tags, ```mermaid fences. Pages are plain MDX: no Fumadocs component imports or JSX components in page bodies.
- Every folder has `meta.json` with `title` and an explicit `pages` order (`---Section---` separators allowed); root `meta.json` has `root: true`. Adding a page means adding it to `meta.json`.
- Links between pages are `/docs/<path>` URLs, never `.mdx` file paths. `README.md` and `PRODUCT.md`, which render on GitHub, link to the `.mdx` files directly.
- One page per adapter (`adapters/<name>.mdx`) and per standard (`standards/<name>.mdx`). Pages carry no `Phase` line and no history. A `Status:` line directly under the frontmatter appears only on pages for something not built yet: `Status: planned` for an adapter or feature, `Status: tracking` for a standard PermDock follows without an adapter. Remove the line in the same PR that ships the code.
- A standards page for an unfinished text adds `Draft posture: build | name | track` under the frontmatter: `build` names the pinned revision in the same line and means PermDock implements that revision with a stable twin; `name` means only identifiers are reserved; `track` means no code and no names. The watch list carries the same value in its Posture column; finished specifications carry none.
- Design rationale lives in a `Why` section on the owning concept or adapter page. There is no ADR folder; when a decision changes, rewrite the `Why` section in place.
- Open questions live only in the Open questions list on `roadmap.mdx`; pages do not carry their own Open questions sections.
- Research is two pages: `research/landscape.mdx` (competing libraries and products; each section ends with Adopt / adapt / avoid) and `research/ecosystem-index.mdx` (every third-party tool PermDock composes with).
- No `{`, `}` or bare `<` in prose (MDX parses them); use backticks.

## When you change X, also update Y

| Change | Also update |
| --- | --- |
| Add or change an adapter entry | `adapters/<name>.mdx` (API), `adapters/index.mdx` matrix, `adapters/meta.json`, the `wire-permdock` skill reference, `apps/examples/<name>`, README "Works with" table, `tests/bundle` measurement |
| Add a public identifier | `getting-started/naming.mdx`, the relevant `concepts/*.mdx`, the skill, `AGENTS.md` naming section, the owning page's `Why` section if it is a new concept |
| Change a wire format (leaf, condition, snapshot, Decision, decision event, approval request, AuthZEN mapping, Problem Details, catalog) | `concepts/wire-formats.mdx` and its `Why` section, `permdock/testing` fixtures, and the PermDock-Cloud repository (it reads these formats). Before the first release, change the format in place and keep `v1`; after it, bump the major |
| Change the Cloud HTTP API or the `ApprovalStore` / `DecisionSink` / `SnapshotSource` interfaces | `adapters/cloud.mdx`, `adapters/approvals.mdx`, `concepts/audit-and-observability.mdx`, `concepts/wire-formats.mdx`, `security/threat-model.mdx` Cloud rows, the PermDock-Cloud repository |
| Add an agent-runtime adapter | `adapters/<name>.mdx` with the outcome mapping table, `security/approvals.mdx` surfaces table, `adapters/index.mdx` denial table, `apps/examples/<name>-agent`, `standards/watch-list.mdx` if the runtime's hook is new |
| Add a condition operator | in-memory evaluator, JSON schema, Drizzle / Prisma / Kysely / RLS compilers (or explicit non-portable marking), `concepts/conditions.mdx`, `adapters/rls.mdx` portable-subset table |
| Add a named-scope rule, membership source, role source or provider membership mapping | `concepts/scopes.mdx`, `concepts/tenancy.mdx`, `concepts/extension-interfaces.mdx`, the provider page "Memberships" section, `concepts/authentication.mdx` source table, `adapters/rls.mdx` membership table mapping, `permdock/testing` policy matrix and conformance runner, `security/threat-model.mdx` tenant rows |
| Add a directory source, a SCIM attribute or extension, or change the `DirectoryStore` interface | `adapters/scim.mdx`, `standards/scim.mdx` attribute table, `concepts/extension-interfaces.mdx` `DirectoryStore` section and `testDirectoryStore` runner, `concepts/authentication.mdx` diagram and Lifecycle, `getting-started/naming.mdx` Spec names, `security/threat-model.mdx` SCIM rows, the PermDock-Cloud repository (the relay replays it) |
| Add a Cloud connector, a CloudEvents `type` or an evidence export format | `adapters/cloud-integrations.mdx` table for its direction (Connector, Standard or interface, What it carries, Never), `concepts/wire-formats.mdx` CloudEvents types, `concepts/audit-and-observability.mdx` Evidence and governance, `research/ecosystem-index.mdx` row per named destination, `security/threat-model.mdx` Cloud rows, the PermDock-Cloud repository; never a new package entry |
| Add a UI hook, composable or store | `concepts/ui.mdx`, every UI adapter page (`react`, `react-native`, `vue`, `svelte`, `solid`), the parity table on `adapters/index.mdx`, `getting-started/naming.mdx` |
| Add a CLI command or flag | `cli/<command>.mdx`, `cli/index.mdx` table, `permdock doctor` if it is a check, the skill |
| Name a third-party tool PermDock composes with (producer, applier, generator, docs host, bridge, MCP host, provider, framework, delivery surface, sink, flag SDK, database) | A row in `research/ecosystem-index.mdx` (mandatory, same PR); the adapter or concept page carrying the recipe; `standards/watch-list.mdx` if it is a specification; never a new package entry without a `Why` update on `adapters/index.mdx` |
| Change the OpenAPI Overlay shape or the `x-badges` hint | `standards/openapi-overlay.mdx`, `adapters/openapi.mdx`, `cli/openapi.mdx`, `adapters/next.mdx` recipe, the lint ruleset file, `permdock/testing` fixtures |
| Add or bump a standard | `standards/<name>.mdx`, `standards/index.mdx` table (including the Maturity column), `standards/watch-list.mdx` row, the adapter page that uses it, `security/*` if it changes the threat model |
| Add a subject provider or claim mapping | `concepts/authentication.mdx` source table, the provider's adapter page "Verified material" section, `security/threat-model.mdx` token rows, `getting-started/naming.mdx` `subjectFrom*` row and "Spec names" table, `standards/openid-connect.mdx` claim table if the claim is an OIDC claim, `concepts/subject.mdx` |
| Add a signed output, a `typ` value or a JWS header parameter | `standards/jose.mdx` produce table, `concepts/wire-formats.mdx` "Signed outputs", `standards/openapi-registry.mdx` `typ` table, the `TokenSigner` section on `concepts/extension-interfaces.mdx`, `permdock/testing` JWS fixtures, `security/threat-model.mdx` signed-output rows |
| Add an `on('auth')` `cause` or a token-verification default (algorithm, `typ`, JWE) | `adapters/jwt.mdx` cause table and defaults, `standards/jose.mdx` checklist, `standards/fapi-2.mdx` if the profile tightens it, `cli/doctor.mdx` if it is a check, `security/threat-model.mdx` token rows |
| Add an OpenAPI extension | `standards/openapi-registry.mdx` table, `standards/openapi.mdx`, `adapters/openapi.mdx`, `cli/openapi.mdx`, the registry PR once the namespace is registered |
| Bump a pinned draft revision (OpenAPI 3.3 Security Profiles, Overlay 1.2, WebMCP, RAR remediation, OpenTelemetry GenAI, Web Bot Auth) or change a draft's posture | The standards page `Draft posture` line, `standards/watch-list.mdx` Posture cell, `x-permdock-catalog.drafts` for document and Overlay output, the emitter's name map and patch schema, `permdock/testing` fixtures keyed by the pin, a changeset; a posture change also updates the standards page's `Why` section |
| Change a security default | `security/threat-model.mdx`, `security/owasp-agentic.mdx` mapping, README "Secure by default" bullet, this file's invariants |
| Add an example app | `apps/examples/<name>`, its adapter page "Example app" section, `tests/e2e`, README table |
| Change the roadmap | `roadmap.mdx`, `Status: planned` lines on affected adapter / standards pages |
| Resolve an open question | State the decision in the owning page's `Why` section and remove it from the Open questions list in `roadmap.mdx` |

## Consumer skills vs this guide

- `packages/permdock/skills/wire-permdock/SKILL.md`: how to add PermDock to an app (define, policy, factory file, first guard, MCP / AI SDK wiring, `permdock doctor`). Written for the consumer's repo.
- `packages/permdock/skills/audit-permissions/SKILL.md`: how to review an existing PermDock setup (ungranted permissions, unused definitions, closures that could be portable, snapshot scope, OWASP ASI02 / ASI03 checklist).
- This file: how to change PermDock itself. Do not put consumer instructions here or maintainer instructions in the skills.

## Working style

- Small PRs, one adapter or one concept each. Public API changes start as an RFC-lite issue and end as an update to the owning page.
- Every user-visible change has a changeset.
- Tests before features for anything touching evaluation semantics; add a case to the policy matrix in `permdock/testing` and, for conditions, to the RLS parity suite.
- Prefer deleting an open question by deciding it over carrying it forward.
