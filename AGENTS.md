# AGENTS.md — maintainer guide for PermDock

This file is for agents and humans changing the PermDock repository. It is not the consumer skill: consumers get `wire-permdock` and `audit-permissions` from the `permdock` package (`npx skills add ScaleDockHQ/PermDock`). `CLAUDE.md` is a symlink to this file; do not fork the two.

The product plan and every design decision live in `PRODUCT.md` and `apps/docs/content/docs/`. Read `apps/docs/content/docs/index.mdx`, `getting-started/naming.mdx` and `security/threat-model.mdx` before touching code.

## Status

Phase 0. The docs tree, README, PRODUCT and this file exist; `packages/`, `apps/docs` (the app itself), `apps/examples/` and `tests/` do not yet. Anything you add must match the layout below so Phase 1 does not have to move it.

## Repo layout

```
packages/
  permdock/           npm `permdock` — src/core, src/conditions, one folder per subpath adapter
                      (react, react-native, next, vue, svelte, solid, server, hono, express, fastify,
                       elysia, nest, node, trpc, orpc, mcp, ai-sdk, claude-agent, webmcp, a2a, authzen,
                       ssf, openapi, otel, drizzle, prisma, kysely, supabase, better-auth, clerk, convex, pdp)
                      skills/ (wire-permdock, audit-permissions) shipped in the package
  cli/                npm `@permdock/cli` — collect, catalog, usage, openapi, rls, doctor, skills;
                      also exports `permdock/next/plugin` (createPermDockPlugin: build-time collect only)
  testing/            npm `@permdock/testing` — policy matrix tests, snapshot fixtures, RLS parity runner, instant() helpers
apps/
  docs/               Fumadocs v16 on Next.js 16.3; content in apps/docs/content/docs (exists today)
  examples/<name>/    one app per adapter: next, react-vite, expo, vue, svelte, solid, hono, express, fastify,
                      elysia, nest, trpc, orpc, mcp-server, ai-sdk-agent, claude-agent, webmcp, a2a-agent,
                      authzen-pdp, supabase-rls, drizzle, prisma, better-auth, clerk, convex, monorepo
tests/
  e2e/                Playwright across examples, including @next/playwright instant()
  types/              TS 5.9 / 6 / 7 matrix
  integration/        Postgres via testcontainers: RLS parity, providers
  bundle/             size budgets per entry (core < 3 kB gzip)
```

## Commands (once Phase 1 lands; keep these names)

```bash
pnpm install
pnpm build                 # turbo run build (tsdown)
pnpm test                  # vitest unit + type tests
pnpm test:e2e              # playwright across apps/examples
pnpm test:integration      # testcontainers Postgres
pnpm lint && pnpm fmt      # oxlint, oxfmt
pnpm check:publish         # publint + arethetypeswrong on every package
pnpm size                  # bundle budgets
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
12. **Zero runtime dependencies in `permdock` core** other than `@standard-schema/spec`. Optional peers (OTel, framework SDKs) are optional.
13. **Naming convention** (below) is part of the public API.

## Naming convention

- The brand is the noun. Type `PermDock`, instance `permdock`, factory `createPermDock`.
- Every server and agent adapter exports `createPermDock`; the import path names the framework (`permdock/next`, `permdock/hono`). Never `NextDock`, `HonoDock`, `dock`, `ability`, `can` as a definer, or `$`-prefixed members.
- React: `PermDockProvider`, `usePermDock`, `usePermission`, `<Protected>` are direct exports of `permdock/react`.
- Servers: `getPermDock` / `getPermission` are the async counterparts of `usePermDock` / `usePermission` (next-intl `use*` / `get*` duality).
- Definitions: `definePermissions`, `resource`, `mergePermissions`, `listPermissions`, `findPermission`. Policy: `definePolicy`, `role`, `allow`, `deny`, `subject`.
- Instance methods: `can`, `decide`, `assert`, `filter`, `where`, `simulate`, `snapshot`, `on`.
- Errors: `PermDockDeniedError`, `PermDockApprovalRequiredError`, `PermDockValidationError`.
- CLI: `permdock <command>`; Next build hook: `createPermDockPlugin` (collect only, never API wiring).

Details and rationale: `apps/docs/content/docs/getting-started/naming.mdx`, `decisions/0005-naming-convention.mdx`.

## Docs conventions (`apps/docs/content/docs`)

- Fumadocs-ready MDX: frontmatter `title` + `description`, no `# h1`, plain Markdown bodies, fenced code with language tags, ```mermaid fences. No Fumadocs components or imports until `apps/docs` is scaffolded.
- Every folder has `meta.json` with `title` and an explicit `pages` order (`---Section---` separators allowed); root `meta.json` has `root: true`. Adding a page means adding it to `meta.json`.
- Links between pages are `/docs/<path>` URLs, never `.mdx` file paths. `README.md` and `PRODUCT.md`, which render on GitHub, link to the `.mdx` files directly.
- One page per adapter (`adapters/<name>.mdx`) and per standard (`standards/<name>.mdx`), each with `Status: planned | in progress | shipped` and `Phase: n` lines directly under the frontmatter. Update `Status` in the same PR that ships the code.
- Decisions are ADRs in `decisions/NNNN-slug.mdx` (Status, Context, Decision, Consequences, Alternatives considered, Related). Append-only; supersede, do not delete. Next number: 0018.
- Research pages end with Adopt / adapt / avoid and Decisions informed.
- No `{`, `}` or bare `<` in prose (MDX parses them); use backticks.

## When you change X, also update Y

| Change | Also update |
| --- | --- |
| Add or change an adapter entry | `adapters/<name>.mdx` (API, Status, Phase), `adapters/index.mdx` matrix, `adapters/meta.json`, the `wire-permdock` skill reference, `apps/examples/<name>`, README "Works with" table, PRODUCT matrix, bundle budget in `tests/bundle` |
| Add a public identifier | `getting-started/naming.mdx`, the relevant `concepts/*.mdx`, the skill, `AGENTS.md` naming section, an ADR if it is a new concept |
| Change a wire format (leaf, condition, snapshot, Decision, AuthZEN mapping, Problem Details, catalog) | `concepts/wire-formats.mdx`, bump the format version, `@permdock/testing` fixtures, an ADR |
| Add a condition operator | in-memory evaluator, JSON schema, Drizzle / Prisma / Kysely / RLS compilers (or explicit non-portable marking), `concepts/conditions.mdx`, `adapters/rls.mdx` portable-subset table |
| Add a CLI command or flag | `cli/<command>.mdx`, `cli/index.mdx` table, `permdock doctor` if it is a check, the skill |
| Add or bump a standard | `standards/<name>.mdx`, `standards/index.mdx` table, the adapter page that uses it, `security/*` if it changes the threat model |
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
