# 0073. eve 1.2.0, ai 7.0.177 and chat 4.45.0 are peer floors; eve 1.2.0 skips the release age; workflow stays at 5.4.0

- Status: accepted
- Date: 2026-11-20
- Amends: 0045 (the open-floor rule stays; these are new floors)

## Context

eve 1.2.0 reached npm at 15:54 UTC on 2026-11-20 and needs Node.js 24 or later; the repository runs Node 24. Its approval types for `permdock/eve` differ from the ones 0.91 shipped by `request.interactionId`, `request.principal`, the `approve` or `deny` decision and `session.turn`. The maintainer accepts that adopters on older eve, ai or chat must upgrade.

`workflow` 5.5.0, 5.6.0 and 5.6.1 fail `trustPolicy: no-downgrade`. Each depends on `@vercel/functions ^3.11.1`, which resolves to 3.11.3, published 2026-11-13 23:55 UTC without provenance. 5.7.0 has the same dependency.

## Decision

- The `peers` catalog floors are `eve >=1.2.0`, `ai >=7.0.177` and `chat >=4.45.0`. Every range stays an open floor with no upper bound. `workflow` stays `>=5`.
- The catalog pins eve 1.2.0, ai 7.0.177, `@ai-sdk/react` 4.0.181, `@ai-sdk/otel` 1.0.177, chat 4.45.0 and `@vercel/detect-agent` 1.2.7. `workflow` stays 5.4.0.
- `minimumReleaseAgeExclude` lists `eve@1.2.0`, that version only. `minimumReleaseAge` stays at 1440 and `trustPolicy` is unchanged. No `trustPolicyExclude` entry is added for `workflow`.
- better-supabase 0.63.2 peers on `eve >=0.71 <1`, so `peerDependencyRules.allowedVersions` lets `better-supabase>eve` resolve to 1.

## Consequences

Remove the eve exclude from 15:56 UTC on 2026-11-21. Retry `workflow` after 2026-12-13 23:55 UTC, when `@vercel/functions` 3.11.3 leaves the 30-day trust window (`trustPolicyIgnoreAfter`). Adopters on eve older than 1.2.0 must upgrade before installing the next permdock release, and the changeset marks the floors as breaking.

## Alternatives considered

- Wait for eve 1.2.0 to pass the release age: the adapter work and the pull request would sit a day for no change in what CI tests.
- Add `workflow` to `trustPolicyExclude`: it would lower the supply-chain gate for a release eve does not need.
