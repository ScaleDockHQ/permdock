# 0076. better-supabase from a tarball of a pinned `main` commit

- Status: superseded by [0079](./0079-better-supabase-0-85-0-floor-and-release-age.md)
- Date: 2026-11-24
- Supersedes the catalog pin of [0075](./0075-better-supabase-0-84-0-pin-and-release-age.md) while the 0.32 branch is open

## Context

The 0.32 work uses better-supabase 0.85 names (`ShareKeyHook`, `AuthorizationTableShare`, `AuthorizationEnforcement`, `VersionStoreEntry`), which are on `main` and in no release.

## Decision

The catalog entry is `better-supabase: file:.better-supabase/better-supabase.tgz`. `scripts/better-supabase-checkout.ts` clones `ScaleDockHQ/better-supabase` at the pinned `COMMIT` (`1b30d3dde9`) into the git-ignored `.better-supabase/source`, builds it and packs it. It never packs a sibling checkout, so local runs, CI and Vercel pack the same tree. `.github/actions/setup` and the `vercel.json` install command run it before `pnpm install`. `peerDependencyRules.allowAny` lists `better-supabase`. `scripts/publish.ts` refuses to publish while a catalog entry is `link:` or `file:`.

`COMMIT` moves in its own commit (`build(deps): better-supabase main at <sha>`) when `main` gains something this branch uses.

## Consequences

better-supabase `main` builds on Node.js 26, which this branch requires. Before the pull request merges, one commit pins the published `0.85.0`, raises the peer floor to `>=0.85.0`, deletes the script, its install steps and the `allowAny` entry, and replaces decision 0075.

## Alternatives considered

- Wait for 0.85.0: blocks every section that reads the new names.
- Pack the sibling checkout: it holds uncommitted work, and the lockfile pins the tarball's integrity.

The example's `supabase:check` and the provider-only integration test pass `--ignore BS607` to `better-supabase doctor`: BS607 compares the installed tarball with the 0.81.0 floor alias in the lockfile. The final pin removes both.
