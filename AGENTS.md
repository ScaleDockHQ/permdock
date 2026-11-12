# AGENTS.md — maintainer guide for PermDock

For agents and humans changing this repository. Consumers get the `permdock` and `permdock-*` skills from the `permdock` package (`npx skills add ScaleDockHQ/PermDock`); consumer instructions never go here and maintainer instructions never go in those skills. `CLAUDE.md` is the one line `@AGENTS.md`; put nothing else there.

`PRODUCT.md` is the product brief. Design decisions and their rationale live in `apps/docs/content/docs/`, in the `Why` section of the page that owns it. Read `index.mdx`, `getting-started/naming.mdx` and `security/threat-model.mdx` there before touching code.

## Rules and conventions

Conventions are rules: code in `architecture.mdc`, names in `naming.mdc`, prose in `writing.mdc`. Topic rules live in `.agents/rules/*.mdc`. Cursor loads them through the `.cursor/rules` symlink and Claude Code through the `.claude/rules/<name>.md` symlinks. Always-on rules load in every session, the others for files matching their globs; if your tool loads neither, read the rule.

| Rule                                   | Read it when                                                                |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `architecture.mdc`                     | Always on: layout, boundary tags, code rules                                |
| `git-workflow.mdc`                     | Always on: one branch and one PR per chat or plan, never merge unasked      |
| `writing.mdc`                          | Always on: prose in docs, skills, changesets, comments, commits, PRs        |
| `source-map.mdc`                       | Changing `packages/permdock`: folder map and a traced call                  |
| `invariants.mdc`                       | Changing `packages/permdock/src`, `tests` or `apps/examples`                |
| `naming.mdc`                           | Adding or renaming a public name, option, flag, denial reason or wire field |
| `naming-supabase.mdc`                  | Naming in `supabase`, `better-supabase`, `cli/rls`, `cli/sql`               |
| `naming-approvals.mdc`                 | Naming in approvals, `jwt`, `cloud`, `ssf`, `scim`, `server`, events        |
| `naming-cli.mdc`                       | Naming in `cli`, `openapi`, generated output                                |
| `naming-adapters.mdc`                  | Naming in UI and agent adapters                                             |
| `cli.mdc`                              | Changing `packages/permdock/src/cli`: manifest, effects, envelope, agents   |
| `change-checklist.mdc`                 | Before opening a PR: what else to update when you change X                  |
| `docs.mdc`                             | Editing `apps/docs/content/docs`                                            |
| `testing.mdc`                          | Writing tests, runners, fixtures or examples                                |
| `deployment.mdc`                       | Touching app code, `packages/{ui,next-config}` or `vercel.json`             |
| `local-dev-portless-agent-browser.mdc` | Running or checking the apps locally                                        |
| `skills.mdc`                           | Touching shipped or vendored skills, `.claude-plugin`, `skills-lock.json`   |
| `reui.mdc`                             | `apps/docs`, `apps/marketing`, `packages/ui`: ReUI design rules             |

A new rule gets `description`, `globs` and `alwaysApply` (Cursor) frontmatter, plus `paths` (Claude Code) unless it is always on, a row here, and a `.claude/rules/<name>.md` symlink.

## Status

`permdock` is on npm; `packages/permdock/package.json` holds the version. Releases follow semver per `roadmap.mdx` Versioning: a breaking change to a name, default or wire format carries a changeset that says so; a breaking wire-format change bumps that format's major. Every wire format is `v1` except the catalog (`catalog-v2.json`, `version: 2`). Node.js 24, pnpm 12.14.0 (`devEngines` downloads it), TypeScript 7.

## Repo layout

```
packages/permdock/    npm `permdock`, the only published package
  src/core, src/conditions, one folder per subpath adapter (react, next, hono, mcp, ai-sdk, drizzle, …)
  src/testing         `permdock/testing`: policy matrix, conformance and scenario runners
  src/cli             the `permdock` bin and `permdock/cli`; commands load on demand
  schemas/ rulesets/ skills/   catalog and OpenAPI schemas, lint ruleset, consumer skills
packages/{typescript-config,next-config,ui}   private presets, createNextConfig(), vendored UI
apps/marketing/ apps/docs/   Next.js 16.4, Vercel Services at `/` and `/docs`
apps/examples/<name>/        one app per adapter
tests/{types,integration,runtimes,bundle}       TS 5.9/6/7, Postgres, Bun/Deno/workerd, size
docs/agents/ docs/decisions/   corrections agents needed twice; exceptions to the repo standard
```

## Commands (keep these names)

```bash
pnpm install
pnpm build                 # turbo run build (tsdown)
pnpm check                 # format:check, lint, typecheck: the fast gate (16 to 24 s cold, 1 s warm)
pnpm check:affected        # the pre-push gate against origin/main, cached
pnpm verify                # every CI gate: root steps, then cached turbo runs
pnpm test                  # vitest unit + type tests; CI also measures coverage
pnpm --filter permdock exec vitest run <path>   # one file: 1 s; tests/core: 6 s; whole package: 35 s
pnpm test:integration      # testcontainers Postgres (Docker)
pnpm test:runtimes         # Bun, Deno, workerd; CI requires all three
pnpm lint && pnpm format   # oxlint, oxfmt; `pnpm fix` applies both
pnpm knip                  # unused files, exports, dependencies
pnpm size                  # per-entry gzip, failing 1% above the record
pnpm generate:perf         # generator time and peak RSS against scripts/generate-perf.json
pnpm runtime:perf && pnpm rls-bench   # runtime matrix, plan-shape gate (Docker)
pnpm gen:check && pnpm doctor   # catalogs and SQL current; doctors
pnpm docs:drift            # docs match doctor codes, entries, names
pnpm dev:portless          # https://permdock.localhost, docs at /docs
pnpm dev:docs              # apps/docs on :3001, no Portless
pnpm dev:marketing         # apps/marketing on :3000, proxies /docs
pnpm env:pull              # .env.local from Vercel development
pnpm changeset             # every user-visible change
```

## Local dev

Run `pnpm exec portless list` and reuse a route. The Portless proxy is shared: never stop it, never run `portless clean` or `prune`, never kill a process you did not start. Check UI with `agent-browser`. [`docs/agents/`](./docs/agents/README.md) lists earlier fixes.

## When you change X, also update Y

| Change                         | Also update                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Env key                        | The app's `env.ts`, `.env.example`, the task `env` in `turbo.json`, Vercel      |
| Route                          | The app's `sitemap.ts`, `deployment.mdc`, a `redirects()` entry for a moved URL |
| UI primitive                   | `packages/ui` through the shadcn CLI; `DESIGN.md` for a new token or pattern    |
| Dependency                     | Catalog pin and "Pre-release pins" (`docs/agents/pnpm-catalog.md`)              |
| `typescript` bump              | `oxlint-tsgolint` in the same commit                                            |
| Next.js bump                   | Run `next dev` per Next.js app; commit the refreshed `AGENTS.md` block          |
| Package version                | `server.json`                                                                   |
| File move                      | Knip entries, the `docs:drift` paths                                            |
| Rename                         | The docs Naming page, the `docs:drift` check, the changeset's old-to-new table  |
| Perf-sensitive change          | The bundle, type and CLI-startup baselines, before and after in the commit      |
| User-visible change            | A changeset; the owning docs page                                               |
| Exception to the repo standard | A record in `docs/decisions`, indexed in its README                             |
| `permdock`, docs or examples   | The rows in `change-checklist.mdc`                                              |

## Hard rules

- Never discard uncommitted work you did not make.
- Read the installed docs (`node_modules/next/dist/docs`, `turbo/docs`, the package README) before configuring them.
- Never lower `minimumReleaseAge`. Pin versions from `pnpm view` at run time.
- Secrets never go in git or `NEXT_PUBLIC_*`. Never set `AI_GATEWAY_API_KEY` or a provider key: the AI Gateway uses Vercel OIDC.
- Fix the code, not the test.

## Invariants

A PR that breaks one is wrong, whatever else it does. Full text in `.agents/rules/invariants.mdc`.

1. **Fail-closed.** Anything unknown, invalid or thrown denies; `can()` never throws; outcomes are only `granted`, `denied`, `approval-required`.
2. **Deny overrides allow.**
3. **No string keys in the public API.** Permissions are references; strings only as `.key` / `.scope` on the wire.
4. **Permission leaves are plain frozen JSON** `{ key, resource, action, scope, meta }`.
5. **Identity is by `key`**, never by object identity.
6. **Portable-first.** A condition operator has an evaluator, a JSON form and ORM / RLS compilation, or `portable: false`.
7. **Immutable, request-scoped instances.** No module-level mutable state, no `AsyncLocalStorage` in core.
8. **No server imports in client entries**; `tests/bundle` asserts it.
9. **Boundary validation** of HTTP bodies, tool args, client `refresh` and model output against the resource schema.
10. **Prototype-safe, no eval.**
11. **Never emit `service_role`**, never trust a model-supplied subject or actor; approval tokens are bound and approvers are distinct.
12. **Runtime entries depend on `@standard-schema/spec` only**; CLI and test code never reach them. The CLI may take regular dependencies; heavy or rare ones are optional peers.
13. **Authentication is upstream.** Core never verifies a token; no subject, membership or tenant from flags, bodies, model args or unsigned headers.
14. **Naming convention** (`naming.mdc`) is public API.
15. **The Cloud is optional** and never on the decision path; every hosted capability is an interface with an in-process default.

## Agent workflow

One branch and one PR per chat or plan, small conventional commits, and merge only when asked and the required checks pass: `git-workflow.mdc`. Public API changes start as an RFC-lite issue and end on the owning page. Tests come before features for evaluation semantics (`testing.mdc`). Decide an open question; never carry it forward.

## Deviations and pins

One record per deviation from the repo standard: [`docs/decisions/README.md`](./docs/decisions/README.md). Pre-release pins and blocked majors: [`docs/agents/pnpm-catalog.md`](./docs/agents/pnpm-catalog.md).

## Turbo agent guidance

`turbo` appends its agent-guidance block below this section when it detects an agent. Commit it as written and leave it last; keep everything above it within 12 KB. Set `"agentGuidance": false` in `turbo.json` only to opt out on purpose.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": true` in the root `turbo.json` or `turbo.jsonc` to opt in; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
