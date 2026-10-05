# AGENTS.md — maintainer guide for PermDock

For agents and humans changing this repository. Consumers get the `permdock` and `permdock-*` skills from the `permdock` package (`npx skills add ScaleDockHQ/PermDock`); consumer instructions never go here and maintainer instructions never go in those skills. `CLAUDE.md` is the one line `@AGENTS.md`; put nothing else there.

`PRODUCT.md` is the product brief. Every design decision and its rationale lives in `apps/docs/content/docs/`, in the `Why` section of the page that owns it. Read `index.mdx`, `getting-started/naming.mdx` and `security/threat-model.mdx` there before touching code.

## Rules

Topic rules live in `.agents/rules/*.mdc`. Cursor loads them through the `.cursor/rules` symlink and Claude Code through the `.claude/rules/<name>.md` symlinks. Always-on rules load in every session; the others attach when you touch a file matching their globs. If your tool loads neither, read the rule for the area you touch.

| Rule                                   | Read it when                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `architecture.mdc`                     | Always on: layout, boundary tags, code rules                                                 |
| `git-workflow.mdc`                     | Always on: one branch and one PR per chat or plan, never merge unasked                       |
| `writing.mdc`                          | Always on: prose in docs, READMEs, skills, changesets, comments, commits, PRs                |
| `invariants.mdc`                       | Changing `packages/permdock/src`, `tests` or `apps/examples`                                 |
| `naming.mdc`                           | Adding or renaming a public identifier, option, flag, denial reason or wire field            |
| `change-checklist.mdc`                 | Before opening a PR: what else to update when you change X                                   |
| `docs.mdc`                             | Editing `apps/docs/content/docs`                                                             |
| `testing.mdc`                          | Writing tests, runners, fixtures or examples                                                 |
| `deployment.mdc`                       | Touching `apps/marketing`, the docs app code, `packages/{ui,next-config}` or `vercel.json`   |
| `local-dev-portless-agent-browser.mdc` | Running or checking the apps locally                                                         |
| `skills.mdc`                           | Touching `packages/permdock/skills`, `.claude-plugin`, vendored skills or `skills-lock.json` |

A new rule gets `description`, `globs` and `alwaysApply` (Cursor) frontmatter, plus `paths` (Claude Code) unless it is always on, a row here, and a `.claude/rules/<name>.md` symlink.

## Status

`permdock@0.1.0` is on npm. Releases follow semver as the Versioning section of `roadmap.mdx` sets out: a breaking change to a name, default or wire format carries a changeset that says so, and a breaking wire-format change bumps that format's major. Every wire format is `v1` (snapshot `v: 1`, approval request `v: 1`, `catalog-v1.json` with `version: 1`). Node.js 24 or later, pnpm 12.8.1 (`devEngines` fails on any other version), TypeScript 7 for the repository.

## Repo layout

```
packages/permdock/    npm `permdock`, the only published package
  src/core, src/conditions, one folder per subpath adapter (react, next, hono, mcp, ai-sdk, drizzle, …)
  src/testing         `permdock/testing`: policy matrix, conformance and scenario runners
  src/cli             the `permdock` bin and `permdock/cli`; commands load on demand
  schemas/ rulesets/ skills/   catalog and OpenAPI schemas, lint ruleset, consumer skills
packages/{typescript-config,ox-config,next-config,ui}   private presets, createNextConfig(), vendored UI
apps/marketing/ apps/docs/   Next.js 16.3, Vercel Services at `/` and `/docs`
apps/examples/<name>/        one app per adapter
tests/{types,integration,runtimes,bundle}       TS 5.9/6/7, Postgres, Bun/Deno/workerd, size
docs/agents/ docs/decisions/   corrections agents needed twice; exceptions to the repo standard
```

## Commands (keep these names)

```bash
pnpm install
pnpm build                 # turbo run build (tsdown)
pnpm check                 # format:check, lint, typecheck: the fast gate
pnpm verify                # every CI gate: root steps, then one cached turbo run
pnpm test                  # vitest unit + type tests
pnpm test:integration      # testcontainers Postgres (Docker)
pnpm test:runtimes         # Bun (on PATH), Deno and workerd; CI requires all three
pnpm lint && pnpm format   # oxlint per workspace, oxfmt over the whole repo
pnpm knip                  # unused files, exports and dependencies
pnpm size                  # per-entry gzip against the baseline
pnpm gen:check && pnpm doctor   # generated catalogs and SQL current; doctors per example
pnpm docs:drift            # docs match doctor codes, entries, meta.json, names
pnpm dev:portless          # https://permdock.localhost, docs at /docs
pnpm dev:docs              # apps/docs on :3001, no Portless
pnpm dev:marketing         # apps/marketing on :3000, proxies /docs
pnpm env:pull              # .env.local from Vercel development
pnpm changeset             # every user-visible change
```

## Local dev

Run `pnpm exec portless list` first and reuse a running PermDock route. The Portless proxy is shared with other repositories: never stop it, never run `portless clean` or `prune` (`pnpm dev:cleanup` is the user's to run), never kill a process you did not start. Check UI changes with `agent-browser` on the Portless URL. [`docs/agents/`](./docs/agents/README.md) lists the fixes agents needed before.

## When you change X, also update Y

| Change                         | Also update                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| Env key                        | The app's `env.ts`, `.env.example`, the task `env` in `turbo.json`, Vercel for each environment  |
| Route                          | The app's `sitemap.ts`, `deployment.mdc` route ownership, a `redirects()` entry for a moved URL  |
| UI primitive                   | Vendor it into `packages/ui` with the shadcn CLI, then `DESIGN.md` if it adds a token or pattern |
| Dependency                     | Catalog pin (`docs/agents/pnpm-catalog.md`), "Pre-release pins" below, the installed docs        |
| `typescript` bump              | `oxlint-tsgolint` in the same commit                                                             |
| Next.js bump                   | Run `next dev` once per Next.js app and commit the refreshed `AGENTS.md` block                   |
| Package version                | `server.json`                                                                                    |
| File move                      | Knip entries, the `docs:drift` paths                                                             |
| Rename                         | The docs Naming page, the `docs:drift` naming check, the changeset's old-to-new table            |
| Perf-sensitive change          | The bundle, type and CLI-startup baselines, before and after in the commit                       |
| User-visible change            | A changeset; the owning docs page                                                                |
| Exception to the repo standard | A record in `docs/decisions` and a line under Deviations                                         |
| `permdock`, docs or examples   | The rows in `change-checklist.mdc`                                                               |

## Hard rules

- Never discard uncommitted work you did not make.
- Read the installed docs (`node_modules/next/dist/docs`, `turbo/docs`, the package README) before configuring Next.js, Turborepo or Fumadocs.
- Never lower `minimumReleaseAge`. Pin versions from `pnpm view` at run time.
- Secrets never go in git or `NEXT_PUBLIC_*`. Never set `AI_GATEWAY_API_KEY` or a provider key: the AI Gateway uses Vercel OIDC.
- Every `as T` has a `// SAFETY:` comment; prefer a type guard or a schema parse.
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

One branch and one PR per chat or plan, small conventional commits (lower-case subject, at most 72 characters), and never merge unless asked and the required checks pass: `git-workflow.mdc`. Public API changes start as an RFC-lite issue and end as an update to the owning page. Tests come before features for evaluation semantics (`testing.mdc`). Decide an open question rather than carry it forward.

## Deviations

Each is a record in `docs/decisions`:

- 0002 no global `typescript` override; 0003 Zod and agent SDKs where PermDock supports them; 0004 `engines.node: ">=24"`
- 0005 extra workspace globs and root scripts; 0006 relaxed tsconfig for vendored UI
- 0008 `turbo query affected`; 0009 boundary rules Turborepo cannot express; 0010 pnpm through Corepack on Vercel
- 0011 no docs `robots.ts`; 0012 cross-zone links are plain anchors; 0013 no `fumadocs-openapi`
- 0015 Ask AI input from `InputGroup`; 0016 Portless names; 0017 `permdock-<topic>` skills; 0018 blocked majors
- 0019 `<Adapter>PermDock` and no `$` members; 0020 the CLI inside `permdock`; 0021 `^build` over `transit`
- 0022 a `Status:` line; 0023 fence titles optional; 0024 root changelog first; 0025 `vercel.json`

## Pre-release pins

- `@orpc/server`, `@orpc/client`, `@orpc/contract`, `@orpc/openapi` 2.0.0-beta.41: `permdock/orpc` targets oRPC 2's `openapi()` metadata.
- `drizzle-orm` 1.0.0-rc.4: the release candidate the standard asks for; the peer also accepts 0.40.
- Prisma 8 and Expo SDK 58 stay on 7.10.0 and SDK 57 until their blockers clear (0018).

## Turbo agent guidance

`turbo` appends a managed agent-guidance block below this section when it detects an agent. Commit it as written and leave it last; keep everything above it within 12 KB; the managed block does not count. Set `"agentGuidance": false` in `turbo.json` only to opt out on purpose.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
