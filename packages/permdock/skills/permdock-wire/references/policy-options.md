# Policy options and CLI starting points

Owning pages: [policies](https://permdock.dev/docs/concepts/policies), [decisions](https://permdock.dev/docs/concepts/decisions), [CLI](https://permdock.dev/docs/cli).

## Usage limits

A `limit: { count, per }` grant needs `limits: memoryLimitStore()` (or the app's `LimitStore`) on `createPermDock`; without it the grant denies with `limit-unavailable`. `can` never consumes a unit: a mutation that spends one calls `decide` or `assert`.

- `mode: 'soft'` keeps granting past the count with an `over-limit` obligation; `alertAt: 0.8` adds a `near-limit` warning.
- A granted decision carries `quota: { remaining, resetsAt }`. An exhausted hard limit answers `429` with `Retry-After` and `RateLimit` headers; for the header format, defer to the `ratelimit-headers` spec skill (`npx skills add ScaleDockHQ/scaledock-skills --skill ratelimit-headers`).
- Run `testLimitStore` from `permdock/testing` on a custom store.

## Hiding rows

On a resource whose ids must not confirm a row exists (a private repository, a patient record), set `disclosure: 'hide'`: a denied row then answers `404` like a missing one.

## Plan gates

Gate a paid feature with `to: [roles.admin, plans.pro]` (an array is an intersection). A held role without the plan is denied with `not-entitled`; the API answers `403` `/not-entitled` with `plans`, and `describe(decision)` returns `kind: 'upgrade'` with the same `plans` for an upgrade link.

## Validity windows

Access that ends on a date (a contractor's engagement, a change freeze until launch) is `validFrom` / `validUntil` on the grant, RFC 3339 or Unix seconds. Outside the window an allow denies with `inactive-grant` and a deny does not apply; `where()` and generated RLS drop it, and `simulate(checks, { now })` previews a date. A person's access ending is the membership's `expiresAt` (see the `permdock-tenancy` skill).

## Step-up

Hardware-key step-up is `to: assurance({ amr: ['hwk'], maxAge: 300 })` and renders `/step-up-required`.

## CLI starting points

- When the app already has an OpenAPI document and no definitions yet, start from `permdock openapi import --doc <doc> --out src/permissions.generated.ts --schema zod` and review each action's `meta.inferredFrom`.
- When the repo has Arazzo workflows, run `permdock arazzo check --doc <arazzo> --openapi <doc>`.
- When the app uses PermDock Cloud, add `permdock cloud push` to the deploy step after the deploy, with `PERMDOCK_CLOUD_URL` and `PERMDOCK_CLOUD_KEY` from CI secrets. The Cloud is optional and never on the decision path.
- `permdock skills install` copies these skills into the project's agent folders.
