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
| `invariants.mdc`                       | Changing `packages/permdock/src`, `tests` or `apps/examples`                |
| `naming.mdc`                           | Adding or renaming a public name, option, flag, denial reason or wire field |
| `cli.mdc`                              | Changing `packages/permdock/src/cli`: manifest, effects, envelope, agents   |
| `change-checklist.mdc`                 | Before opening a PR: what else to update when you change X                  |
| `docs.mdc`                             | Editing `apps/docs/content/docs`                                            |
| `testing.mdc`                          | Writing tests, runners, fixtures or examples                                |
| `deployment.mdc`                       | Touching app code, `packages/{ui,next-config}` or `vercel.json`             |
| `local-dev-portless-agent-browser.mdc` | Running or checking the apps locally                                        |
| `skills.mdc`                           | Touching shipped or vendored skills, `.claude-plugin`, `skills-lock.json`   |
| `reui.mdc`                             | Always on: ReUI design rules for UI edits                                   |

A new rule gets `description`, `globs` and `alwaysApply` (Cursor) frontmatter, plus `paths` (Claude Code) unless it is always on, a row here, and a `.claude/rules/<name>.md` symlink.

## Status

`permdock` is on npm; `packages/permdock/package.json` holds the version. Releases follow semver per the Versioning section of `roadmap.mdx`: a breaking change to a name, default or wire format carries a changeset that says so, and a breaking wire-format change bumps that format's major. Every wire format is `v1` (snapshot `v: 1`, approval request `v: 1`, `catalog-v1.json` with `version: 1`). Node.js 24, pnpm 12.14.0 (`devEngines` refuses others), TypeScript 7.

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
pnpm check                 # format:check, lint, typecheck: the fast gate
pnpm verify                # every CI gate: root steps, then one cached turbo run
pnpm test                  # vitest unit + type tests
pnpm test:integration      # testcontainers Postgres (Docker)
pnpm test:runtimes         # Bun (on PATH), Deno and workerd; CI requires all three
pnpm lint && pnpm format   # oxlint per workspace, oxfmt everywhere; `pnpm fix` applies both
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

| Change                         | Also update                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Env key                        | The app's `env.ts`, `.env.example`, the task `env` in `turbo.json`, Vercel      |
| Route                          | The app's `sitemap.ts`, `deployment.mdc`, a `redirects()` entry for a moved URL |
| UI primitive                   | `packages/ui` through the shadcn CLI; `DESIGN.md` for a new token or pattern    |
| Dependency                     | Catalog pin (`docs/agents/pnpm-catalog.md`), "Pre-release pins" below           |
| `typescript` bump              | `oxlint-tsgolint` in the same commit                                            |
| Next.js bump                   | Run `next dev` per Next.js app; commit the refreshed `AGENTS.md` block          |
| Package version                | `server.json`                                                                   |
| File move                      | Knip entries, the `docs:drift` paths                                            |
| Rename                         | The docs Naming page, the `docs:drift` check, the changeset's old-to-new table  |
| Perf-sensitive change          | The bundle, type and CLI-startup baselines, before and after in the commit      |
| User-visible change            | A changeset; the owning docs page                                               |
| Exception to the repo standard | A record in `docs/decisions` and a line under Deviations                        |
| `permdock`, docs or examples   | The rows in `change-checklist.mdc`                                              |

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

One branch and one PR per chat or plan, small conventional commits, and merge only when asked and the required checks pass: `git-workflow.mdc`. Public API changes start as an RFC-lite issue and end on the owning page. Tests come before features for evaluation semantics (`testing.mdc`). Decide an open question; never carry it forward.

## Deviations

Records in `docs/decisions`:

- 0002 no global `typescript` override; 0003 Zod and agent SDKs; 0004 `engines.node: ">=24"`
- 0005 extra workspaces and root scripts; 0006 relaxed tsconfig for vendored UI
- 0008 `turbo query affected`; 0009 extra boundary rules; 0010 Corepack on Vercel
- 0011 no docs `robots.ts`; 0012 plain cross-zone anchors; 0013 no `fumadocs-openapi`
- 0015 Ask AI input from `InputGroup`; 0016 Portless names; 0017 `permdock-<topic>` skills; 0018 blocked majors
- 0019 `<Adapter>PermDock` and no `$` members; 0020 the CLI inside `permdock`; 0021 `^build` over `transit`
- 0022 a `Status:` line; 0023 fence titles optional; 0024 root changelog first; 0025 `vercel.json`
- 0026 no commit header length limit; 0027 7-day Dependabot cooldown; 0052 Ultracite kept-off rules
- 0029 no Turbopack CI cache; 0030 `Vary` only on Markdown
- 0031 `tests/*` outside Vitest `projects`; 0032 no `actions.lock`; 0033 `jsx: "react-jsx"`; 0034 `Instant` over `Temporal`; 0037 shared CLI contract; 0038-0041, 0046-0048, 0050-0051, 0053 better-supabase release age and floor; 0042 `oxc-parser`, `jiti` as deps; 0044 lint rules kept off; 0045 open peer ranges; 0049 hook gate

## Pre-release pins

- `@orpc/server`, `@orpc/client`, `@orpc/contract`, `@orpc/openapi` 2.0.0-beta.42: `permdock/orpc` targets oRPC 2's `openapi()` metadata.
- `drizzle-orm` 1.0.0-rc.5-5935859: the release candidate the standard asks for; the peer also accepts 0.40.
- `@supabase/pg-delta` 1.0.0-alpha.60, `pg-topo` 1.0.0-alpha.8: Declarative Schemas 2.0 for `tests/integration` and `db diff`; no stable release.
- Prisma 8 and Expo SDK 58 stay on 7.10.0 and SDK 57 until their blockers clear (0018).

## Turbo agent guidance

`turbo` appends its agent-guidance block below this section when it detects an agent. Commit it as written and leave it last; keep everything above it within 12 KB. Set `"agentGuidance": false` in `turbo.json` only to opt out on purpose.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": true` in the root `turbo.json` or `turbo.jsonc` to opt in; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

<!-- BEGIN:reui-agent-rules -->

## ReUI design rules (every UI edit, follow-ups included)

This project uses an existing design system: ReUI on shadcn/ui. Keep its look. Generic frontend advice (vary fonts or themes, gradients, page-load or staggered reveals, "2-3 intentional motions", Framer Motion) does not apply here, and other design skills lose where they disagree.

1. Use installed components first (`components/ui`, `components/reui`): tables `data-grid`, filtering `filters`, boards `kanban`, modals `Dialog` or `AlertDialog`, toasts `sonner`. Never set height, radius, padding, shadow or motion on them; use `size`, `variant`, `spacing`.
2. Color: semantic tokens. State: `<Badge variant="success-light">` from `@/components/reui/badge` at default size, or Alert variants. Raw palette only for categorical identity, with its `dark:` pair.
3. Spacing: `gap-*` on the parent: `gap-1` to `gap-2` in a row, `gap-3` to `gap-4` between groups, `gap-6` to `gap-8` between sections. Type: `text-sm` body, `text-xs` meta, nothing smaller; never resize FrameTitle or CardTitle.
4. Motion: installed parts already animate; never retime them. Yours: hover `transition-colors`; reveal `duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]`; transform and opacity only; never `transition-all`, bounce, or a stagger on table rows or lists of 20+; at most 1 entrance per view; `MotionConfig reducedMotion="user"` plus `motion-reduce:`.
5. Every data region: empty state with an action, `Skeleton` loading, inline error with Retry.
6. Before UI code, write the plan from `.agents/skills/reui/SKILL.md` in your reply. Before you finish, run its self-check on the files you changed and fix every hit (2 rounds at most). Full rules: `.agents/skills/reui/SKILL.md`. If that folder is missing, call the `reui` MCP tool `get_agent_skill`.

Managed by the ReUI installer. Edits between the markers are replaced on the next run.
<!-- END:reui-agent-rules -->
