# AGENTS.md — maintainer guide for PermDock

For agents and humans changing this repository. Consumers get the `wire-permdock` and `audit-permissions` skills from the `permdock` package (`npx skills add ScaleDockHQ/PermDock`); consumer instructions never go here and maintainer instructions never go in those skills. `CLAUDE.md` is the one line `@AGENTS.md`; put nothing else there.

`PRODUCT.md` is the product brief. Every design decision and its rationale lives in `apps/docs/content/docs/`, in the `Why` section of the page that owns it. Read `index.mdx`, `getting-started/naming.mdx` and `security/threat-model.mdx` there before touching code.

## Rules

Topic rules live in `.agents/rules/*.mdc`. Cursor loads them through the `.cursor/rules` symlink and Claude Code through the `.claude/rules/<name>.md` symlinks; both attach a rule when you touch a file matching its globs. If your tool loads neither, read the rule for the area you touch.

| Rule | Read it when |
| --- | --- |
| `invariants.mdc` | Changing `packages/permdock/src`, `tests` or `apps/examples`: the full text of the invariants below |
| `naming.mdc` | Adding or renaming a public identifier, option, flag, denial reason or wire field |
| `change-checklist.mdc` | Before opening a PR: what else to update when you change X |
| `docs.mdc` | Editing `apps/docs/content/docs` |
| `testing.mdc` | Writing tests, runners, fixtures or examples |
| `deployment.mdc` | Touching `apps/marketing`, the docs app code or `vercel.json` |
| `skills.mdc` | Touching `packages/permdock/skills`, `.claude-plugin`, vendored skills or `skills-lock.json` |
| `writing.mdc` | Writing any prose: docs, READMEs, skills, changesets, comments, commits, PRs |

A new rule gets `description`, `globs` and `alwaysApply` (Cursor) plus `paths` (Claude Code) frontmatter, a row in this table, and a `.claude/rules/<name>.md` symlink (Claude Code ignores `.mdc`).

## Status

Pre-release. Everything here is the 0.1.0 baseline; nothing has shipped, so there is no compatibility to keep: change a name or format in place. Every wire format is `v1` (snapshot `v: 1`, approval request `v: 1`, `catalog-v1.json` with `version: 1`). Node.js 24 or later, pnpm 12.8.1 (`devEngines` fails on any other version), TypeScript 7 for the repository.

## Repo layout

```
packages/
  permdock/           npm `permdock`, the only published package (`scaledockhq` npm org)
    src/core, src/conditions, one folder per subpath adapter (react, next, hono, mcp, ai-sdk, drizzle, …)
    src/testing       `permdock/testing`: policy matrix, conformance and scenario runners, `permdock/testing/saas`
    src/cli           the `permdock` bin (collect, catalog, usage, openapi, rls, doctor, skills, cloud, arazzo)
                      and `permdock/cli`; commands load on demand
    src/next/plugin.ts, src/unplugin   build-time collect hooks only
    schemas/ rulesets/ skills/         catalog and OpenAPI schemas, lint ruleset, consumer skills
  typescript-config/  private tsconfig presets: base, library, react-library, next
  ox-config/          private oxlint and oxfmt config; root configs add repo ignores and `typeAware`
apps/
  marketing/          Next.js 16.3 marketing site, Vercel Service at `/`
  docs/               Fumadocs on Next.js 16.3, content in apps/docs/content/docs, Vercel Service at `/docs`
  examples/<name>/    one app per adapter (eve-agent doubles as the PermDock Cloud Marketplace template)
tests/
  e2e/                Playwright over examples; fixtures/<name> scenario apps over permdock/testing/saas
  types/              public types under TS 5.9 / 6 / 7
  integration/        Postgres via testcontainers: RLS parity, providers
  runtimes/           Bun, Deno and workerd
  bundle/             per-entry gzip baseline, client-entry and dependency assertions
.agents/rules/        topic rules (see Rules); .agents/skills/ vendored skills pinned in skills-lock.json
```

## Commands (keep these names)

```bash
pnpm install
pnpm build                 # turbo run build (tsdown)
pnpm test                  # vitest unit + type tests
pnpm test:e2e              # playwright across apps/examples
pnpm test:integration      # testcontainers Postgres (Docker)
pnpm test:runtimes         # Bun (on PATH), Deno and workerd; CI requires all three
pnpm lint && pnpm fmt      # oxlint, oxfmt over the whole repo
pnpm typecheck             # turbo run typecheck (tsc --noEmit per package)
pnpm check                 # fmt:check + lint + typecheck; CI and the pre-push hook
pnpm check:publish         # publint + arethetypeswrong
pnpm size                  # per-entry gzip measurements
pnpm docs:drift            # docs match CLI flags, doctor codes, package entries, meta.json
pnpm docs:dev              # apps/docs on :3001
pnpm marketing:dev         # apps/marketing on :3000, proxies /docs
pnpm changeset             # every user-visible change
```

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
12. **Runtime entries depend on `@standard-schema/spec` only**; CLI and test code never reach them.
13. **Authentication is upstream.** Core never verifies a token; no subject, membership or tenant from flags, bodies, model args or unsigned headers.
14. **Naming convention** (`naming.mdc`) is public API.
15. **The Cloud is optional** and never on the decision path; every hosted capability is an interface with an in-process default.

## Working style

- Small PRs, one adapter or one concept each. Public API changes start as an RFC-lite issue and end as an update to the owning page.
- Every user-visible change has a changeset; CI-only changes do not.
- Tests before features for anything touching evaluation semantics (`testing.mdc`).
- Prefer deleting an open question by deciding it over carrying it forward.
- Conventional commits, lower-case subject, at most 72 characters. The PR body follows `.github/PULL_REQUEST_TEMPLATE.md`.

## Turbo agent guidance

`turbo` appends a managed agent-guidance block below this section when it detects an agent. Commit it as written and leave it last; keep everything above it under 10 KB so the file stays within 12 KB. Set `"agentGuidance": false` in `turbo.json` only to opt out on purpose.
