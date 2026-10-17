# 0035. better-supabase from a tarball of the sibling checkout

- Status: accepted
- Date: 2026-10-17

## Context

`permdock/better-supabase` fills `AuthorizationHooks`, `functions.permitted`, `operations` and `delegation.scopes`, which better-supabase has on `main` but in no release. The standard pins every dependency to a published version from the catalog.

## Decision

The catalog entry is `better-supabase: file:.better-supabase/better-supabase.tgz`. `scripts/better-supabase-checkout.ts` packs the sibling checkout `../better-supabase` into the git-ignored `.better-supabase/`. Without a sibling, as in CI and on Vercel, it clones `ScaleDockHQ/better-supabase` at a pinned commit into `.better-supabase/source` and builds it first. `.github/actions/setup` and the `vercel.json` install commands run it before `pnpm install`. `peerDependencyRules.allowAny` lists `better-supabase`, because a tarball has no version for the `permdock` peer range to match. `scripts/publish.ts` refuses to publish while any catalog entry is `link:` or `file:`.

## Consequences

The lockfile pins the tarball's integrity, so CI packs the same commit the lockfile was written from; the script warns when the local checkout is at another commit. After changing the sibling, run `node scripts/better-supabase-checkout.ts --force` and `pnpm install`, then bump `COMMIT` once the change is pushed. Revert to a version pin, and drop the `allowAny` entry and the setup steps, when better-supabase releases these slots.

## Alternatives considered

- `link:../better-supabase/packages/better-supabase`: the linked package resolves its peers from the sibling's `node_modules`, so the example loaded a second Next.js.
- `file:` on the package directory: pnpm reads the sibling's `package.json`, whose `catalog:` ranges it cannot resolve.
