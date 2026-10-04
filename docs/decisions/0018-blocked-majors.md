# 0018. Majors that stay on the previous line

- Status: accepted
- Date: 2026-10-03

## Context

The repo standard pins every dependency to its newest release that passes `minimumReleaseAge`. On 2026-10-03 several majors were either not stable yet or broke a part of this repository that the release cannot fix on our side. Each one below stays on its previous line until the blocker in its row clears.

## Decision

| Package                                                               | Stays on               | Newest                                     | Blocker                                                                                                                                                                                              | Clears when                                                                    |
| --------------------------------------------------------------------- | ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `@sveltejs/kit`, `@sveltejs/adapter-node`                             | 2.70.3, 5.5.7          | 3.0.0, 6.0.0                               | `svelte-kit sync` calls `ts.sys` from the TypeScript JS API, which TypeScript 7 does not ship; the `sveltekit-saas` fixture cannot generate types                                                    | Kit reads tsconfig without the TypeScript JS API, or ships a TypeScript 7 path |
| `expo` and the SDK packages, `react-native`, `react-native-screens` 5 | SDK 57, 0.86.3, 4.28.0 | SDK 58.0.3 (`next`), 0.87.1, 5.0.0-alpha.3 | SDK 58 is still on the `next` tag and was published inside the release-age window; screens 5 is an alpha                                                                                             | SDK 58 moves to `latest` and is a day old                                      |
| `prisma`, `@prisma/client`, `@prisma/adapter-pg`                      | 7.10.0                 | 8.0.0-rc.19                                | Prisma 8 replaces `@prisma/client` with `@prisma/orm-postgres` and a contract-first query API; `permdock/prisma` compiles to the Prisma 7 `where` input, so 8 needs a new compile target, not a bump | Prisma 8 is stable and `permdock/prisma` has a Prisma 8 target                 |
| `solid-js`                                                            | 1.9.15                 | 2.0.0-rc.13 (`next`)                       | Release candidate                                                                                                                                                                                    | 2.0.0 on `latest`                                                              |
| `elysia`                                                              | 1.4.30                 | 2.0.0-beta.21 (`next`)                     | Beta                                                                                                                                                                                                 | 2.0.0 on `latest`                                                              |
| `fastify`                                                             | 5.12.5                 | 6.0.0-alpha.4 (`next`)                     | Alpha                                                                                                                                                                                                | 6.0.0 on `latest`                                                              |
| `@supabase/supabase-js`                                               | 2.117.2                | 3.0.0-next.29 (`next`)                     | Prerelease, and better-supabase 0.5.1 peers on `^2.116.0`                                                                                                                                            | 3.0.0 on `latest` and a better-supabase release that accepts it                |
| `rxjs`                                                                | 7.8.2                  | 9.0.0-beta.0 (`next`)                      | Beta; Nest 12 peers on `rxjs ^7.1.0`                                                                                                                                                                 | 9.0.0 on `latest` and Nest accepts it                                          |
| `yaml`                                                                | 2.9.1                  | 3.0.0-2 (`next`)                           | Prerelease                                                                                                                                                                                           | 3.0.0 on `latest`                                                              |
| `multer`                                                              | 2.4.0                  | 3.0.0-alpha.2 (`next`)                     | Alpha                                                                                                                                                                                                | 3.0.0 on `latest`                                                              |
| `miniflare`                                                           | 4.20260730.0           | 5.20261001.0-alpha                         | Alpha                                                                                                                                                                                                | A non-alpha 5.x release                                                        |

`drizzle-orm` 1.0.0-rc.4, `motion` 14 and `@streamdown/code` 2 were adopted in the same change: the first is the `rc` the standard asks for, and the other two built and passed their tests unchanged.

## Consequences

Dependabot keeps proposing these majors; close each PR with a link to this record until its row clears. When a row clears, bump it in its own PR, delete the row, and mark this record superseded once the table is empty.

## Alternatives considered

- Adopting the prereleases: an alpha or release candidate in a published peer range is forced on every consumer.
- Holding every major back: the stable ones (`motion` 14, `@streamdown/code` 2) would wait for nothing.
