# 0035. better-supabase from a tarball of the sibling checkout

- Status: superseded by 0038 (2026-10-19)
- Date: 2026-10-17

## Context

`permdock/better-supabase` fills `AuthorizationHooks`, `functions.permitted`, `operations` and `delegation.scopes`, which better-supabase has on `main` but in no release. The standard pins every dependency to a published version from the catalog.

## Decision

The catalog entry is `better-supabase: file:.better-supabase/better-supabase.tgz`. `scripts/better-supabase-checkout.ts` packs the sibling checkout `../better-supabase` into the git-ignored `.better-supabase/`. Without a sibling, as in CI and on Vercel, it clones `ScaleDockHQ/better-supabase` at a pinned commit into `.better-supabase/source` and builds it first. `.github/actions/setup` and the `vercel.json` install commands run it before `pnpm install`. `peerDependencyRules.allowAny` lists `better-supabase`, because a tarball has no version for the `permdock` peer range to match. `scripts/publish.ts` refuses to publish while any catalog entry is `link:` or `file:`.

## Consequences

The lockfile pins the tarball's integrity, so CI packs the same commit the lockfile was written from; the script warns when the local checkout is at another commit. After changing the sibling, run `node scripts/better-supabase-checkout.ts --force` and `pnpm install`, then bump `COMMIT` once the change is pushed. The script packs the sibling's working tree, uncommitted edits included; when the sibling has any, pack from a clean `git worktree` at `COMMIT` instead, or the lockfile integrity will not match CI. `COMMIT` is `b69e916e8` (better-supabase `main`, 2026-10-19), the first commit with the shared CLI contract that 0037 describes.

The `permdock` peer range is `>=0.9.0 <0.10.0` (2026-10-18), because the slots exist only from 0.9. The tarball still reports version 0.8.0, so `allowAny` stays. `tests/better-supabase/peer-floor.test.ts` checks that every name `src/better-supabase` imports exists in the installed package; until 0.9.0 is on npm that package is the tarball.

When better-supabase 0.9.0 is on npm:

1. Set the catalog entry to `better-supabase: 0.9.0`.
2. Add `better-supabase-floor: npm:better-supabase@0.9.0` to the `permdock` dev dependencies, so the peer-floor test reads the lowest version of the range even after the dev pin moves on.
3. Drop the `allowAny` entry, the `.github/actions/setup` and `vercel.json` steps and `scripts/better-supabase-checkout.ts`.
4. Set this record to `superseded` with the date.

## Alternatives considered

- `link:../better-supabase/packages/better-supabase`: the linked package resolves its peers from the sibling's `node_modules`, so the example loaded a second Next.js.
- `file:` on the package directory: pnpm reads the sibling's `package.json`, whose `catalog:` ranges it cannot resolve.
