# Decision records

Each file records one place where this repository differs from the ScaleDockHQ repo standard, and why. Product and API design decisions do not go here: they live in the `Why` section of the owning page in `apps/docs/content/docs`.

Copy `0000-template.md`, take the next number, and add a row below. When a decision changes, set its status to superseded and add a new record.

| Record                                                            | Decision                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [0001](./0001-skills-in-agents-folder.md)                         | Withdrawn: the standard now commits lock-tracked skills                                                |
| [0002](./0002-no-typescript-catalog-override.md)                  | No global `typescript` override                                                                        |
| [0003](./0003-schema-libraries.md)                                | Zod, ArkType and agent SDKs where PermDock supports them                                               |
| [0004](./0004-node-engines.md)                                    | `permdock` keeps `engines.node: ">=24"`                                                                |
| [0005](./0005-extra-workspaces-and-scripts.md)                    | Extra workspace globs and root scripts                                                                 |
| [0006](./0006-vendored-ui-tsconfig.md)                            | Relaxed tsconfig for vendored UI code                                                                  |
| [0007](./0007-permdock-tests-not-type-checked.md)                 | Withdrawn: the tests are type-checked                                                                  |
| [0008](./0008-turbo-query-affected.md)                            | `turbo query affected` instead of `turbo-ignore`                                                       |
| [0009](./0009-boundaries-limits.md)                               | Boundary rules Turborepo cannot express, and the `ui` denylist                                         |
| [0010](./0010-vercel-corepack-bootstrap.md)                       | `vercel.json` bootstraps pnpm through Corepack                                                         |
| [0011](./0011-docs-robots.md)                                     | The docs app has no `robots.ts`                                                                        |
| [0012](./0012-cross-zone-links.md)                                | Cross-zone links are plain anchors                                                                     |
| [0013](./0013-no-fumadocs-openapi.md)                             | No `fumadocs-openapi` pages                                                                            |
| [0014](./0014-no-fumadocs-twoslash.md)                            | Withdrawn: no page uses Twoslash, which the standard now allows                                        |
| [0015](./0015-ask-ai-input.md)                                    | Ask AI input built from `InputGroup`                                                                   |
| [0016](./0016-portless-names.md)                                  | Portless names under `permdock.localhost`                                                              |
| [0017](./0017-permdock-skill-prefix.md)                           | Consumer skills are named `permdock` or `permdock-<topic>`                                             |
| [0018](./0018-blocked-majors.md)                                  | Majors that stay on the previous line until a blocker clears                                           |
| [0019](./0019-adapter-suffix-and-no-dollar-members.md)            | Adapter types are `<Adapter>PermDock`, and no public object has `$` members                            |
| [0020](./0020-cli-inside-the-package.md)                          | The CLI ships inside `permdock`, not as `@scaledockhq/cli`                                             |
| [0021](./0021-build-over-transit.md)                              | Checks depend on `^build`, not `transit`                                                               |
| [0022](./0022-status-line-for-unbuilt-features.md)                | Unbuilt features carry a `Status:` line, not a callout                                                 |
| [0023](./0023-code-fence-titles.md)                               | Code fences need a language, not a title                                                               |
| [0024](./0024-version-packages-order.md)                          | The root changelog runs before `changeset version`                                                     |
| [0025](./0025-vercel-json-over-vercel-ts.md)                      | `vercel.json` instead of `vercel.ts`                                                                   |
| [0026](./0026-commit-header-length.md)                            | Commit headers without a length limit                                                                  |
| [0027](./0027-dependabot-cooldown.md)                             | Dependabot waits 7 days                                                                                |
| [0028](./0028-ox-config-over-ultracite.md)                        | Withdrawn: lint and format run on Ultracite                                                            |
| [0029](./0029-no-turbopack-build-cache-in-ci.md)                  | No Turbopack build cache on GitHub runners                                                             |
| [0030](./0030-vary-on-markdown-only.md)                           | `Vary: Accept` only on the Markdown response                                                           |
| [0031](./0031-tests-outside-root-vitest-projects.md)              | `tests/*` stays outside the root Vitest `projects`                                                     |
| [0032](./0032-no-actions-lock-yet.md)                             | No `actions.lock` until workflow lockfiles are generally available                                     |
| [0033](./0033-next-tsconfig-react-jsx.md)                         | `next.json` sets `jsx: "react-jsx"`                                                                    |
| [0034](./0034-structural-instant-over-temporal.md)                | The runtime takes a structural `Instant`, not `Temporal`                                               |
| [0035](./0035-better-supabase-from-a-tarball.md)                  | Superseded by 0038: better-supabase installed from a tarball of the sibling checkout                   |
| [0036](./0036-org-and-row-access-on-one-resource.md)              | Org-level and per-row access on one resource, not two; PD075 reports a split                           |
| [0037](./0037-cli-contract-shared-with-better-supabase.md)        | The CLI contract shared with better-supabase: exit 3, envelope, agent mode, own resolver               |
| [0038](./0038-better-supabase-0-9-0-release-age-exclude.md)       | better-supabase 0.9.0 skips the one-day release age                                                    |
| [0039](./0039-better-supabase-0-10-0-release-age-exclude.md)      | better-supabase 0.10.0 skips the one-day release age                                                   |
| [0040](./0040-better-supabase-0-11-0-floor-and-release-age.md)    | better-supabase 0.11.0 is the peer floor, with no upper bound, and skips the one-day release age       |
| [0041](./0041-better-supabase-0-12-0-release-age-exclude.md)      | better-supabase 0.12.0 skips the one-day release age                                                   |
| [0042](./0042-two-cli-runtime-dependencies.md)                    | The CLI inlines its dependencies except `oxc-parser` and `jiti`                                        |
| [0043](./0043-better-supabase-peer-upper-bound.md)                | The better-supabase peer range ends below the minor after the newest tested release                    |
| [0044](./0044-lint-rules-kept-off.md)                             | Lint rules kept off by design, and the remaining backlogs                                              |
| [0045](./0045-open-peer-ranges-and-better-supabase-0-13-floor.md) | Peer ranges are open floors; better-supabase 0.13.0 is the floor and skips the release age             |
| [0046](./0046-better-supabase-0-15-1-release-age.md)              | better-supabase 0.15.1 is the catalog pin and skips the release age; the example stack runs on it only |
| [0047](./0047-better-supabase-0-16-0-release-age.md)              | better-supabase 0.16.0 is the catalog pin and skips the release age                                    |
| [0048](./0048-better-supabase-0-18-0-release-age.md)              | better-supabase 0.18.0 is the catalog pin and skips the release age                                    |
| [0049](./0049-affected-hook-gate.md)                              | Affected lint and typecheck on commit, no tests in hooks, `CI` not hashed                              |
| [0050](./0050-better-supabase-0-25-0-release-age.md)              | better-supabase 0.25.0 catalog pin, release age exception and three-version compatibility CI           |
| [0051](./0051-better-supabase-0-29-0-floor-and-release-age.md)    | better-supabase 0.29.0 is the peer floor and catalog pin, and skips the release age                    |
| [0052](./0052-ultracite-presets-and-kept-off-rules.md)            | Ultracite `core` and `anti-slop` only, house presets in the root config, kept-off rules with counts    |
| [0053](./0053-better-supabase-0-33-0-floor-and-release-age.md)    | better-supabase 0.33.0 is the peer floor and catalog pin, and skips the release age                    |
