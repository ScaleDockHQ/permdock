# Policy options and CLI starting points

Owning pages: [policies](https://permdock.com/docs/concepts/policies), [decisions](https://permdock.com/docs/concepts/decisions), [CLI](https://permdock.com/docs/cli).

## Usage limits

A `limit: { count, per }` grant needs `limits: limits(memoryLimitStore())` (or `limits(store)` over the app's `LimitStore`) on `createPermDock`; without it the grant denies with `limit-unavailable`. `can` never consumes a unit: a mutation that spends one calls `decide` or `assert`.

- `mode: 'soft'` keeps granting past the count with an `over-limit` obligation; `alertAt: 0.8` adds a `near-limit` warning.
- A granted decision carries `quota: { remaining, resetsAt }`. An exhausted hard limit answers `429` with `Retry-After` and `RateLimit` headers; for the header format, defer to the `ratelimit-headers` spec skill (`npx skills add ScaleDockHQ/scaledock-skills --skill ratelimit-headers`).
- Run `testLimitStore` from `permdock/testing` on a custom store.

## Hiding rows

On a resource whose ids must not confirm a row exists (a private repository, a patient record), set `disclosure: 'hide'`: a denied row then answers `404` like a missing one.

## Plan gates

Gate a paid feature with `to: [roles.admin, plans.pro]` (an array is an intersection). A held role without the plan is denied with `not-entitled`; the API answers `403` `/not-entitled` with `plans`, and `describe(decision)` returns `kind: 'upgrade'` with the same `plans` for an upgrade link.

Localise `describe` with `messages`. `messages.reasons` is a record per denial reason or a function `(reason, decision) => string | undefined` that also sees the denied decision; `undefined` keeps the reason code.

## Validity windows

Access that ends on a date (a contractor's engagement, a change freeze until launch) is `validFrom` / `validUntil` on the grant, an RFC 3339 string or an `Instant` such as a `Temporal.Instant`. Outside the window an allow denies with `inactive-grant` and a deny does not apply; `where()` and generated RLS drop it, and `simulate(checks, { now })` previews an instant (`now` is an `Instant`). A person's access ending is the membership's `expiresAt` (see the `permdock-tenancy` skill).

## Step-up

Hardware-key step-up is `to: assurance({ amr: ['hwk'], maxAge: 300 })` and renders `/step-up-required`.

## Existing apps

Adopting PermDock in an app with its own keys, SQL helpers and tokens is a step-by-step guide ([existing apps](https://permdock.com/docs/getting-started/existing-apps)):

- Keep the app's keys. Map verbs such as `view` to SQL with `rls.actions`, and give colliding resources a distinct `name` on `resource()`.
- Put application-owned metadata in `meta.x`; PermDock carries it and never reads it (see App data below).
- Rename a key later with `definePermissions(tree, { renamed: { "old.key": "new.key" } })`. Remove the alias only when `permdock doctor` PD055 and PD056 are quiet; `permdock diff` reports the removal as the breaking `alias-removed`.
- Generate helpers beside legacy SQL with `permdock rls generate --helpers-only --shims`, then rewrite policies with `permdock rls migrate`.

## App data and app obligations

Owning page: [extend PermDock](https://permdock.com/docs/guides/extending).

- Type `x` with one Standard Schema per kind: `definePermissions(tree, { x: { permission, resource } })`, `defineRoles(tree, { x })`, `definePlans(tree, { x })`, `definePolicy(…, { x: { grant, membership } })`. Each schema validates synchronously. Invalid `x` in code throws; invalid `Membership.x` or custom-role `meta.x` from a source is dropped and the row stays.
- Describe a grant with `allow(p, { name, meta: { description, x } })`. It reaches `decision.matched`, decision events, snapshot grants and catalog grants, and stays out of the policy fingerprint.
- Steer code on a grant with `allow(p, { obligations: ['watermark', { name, detail }] })`, never on a deny. Read `{ kind: 'app', name, detail? }` from `decision.obligations` on a granted decision.
- Snapshots carry grant `meta`, membership `x` and every leaf's `meta` to the client: never put a secret in them.

## CLI starting points

- When the app already has an OpenAPI document and no definitions yet, start from `permdock openapi import --doc <doc> --out src/permissions.generated.ts --validator zod` and review each action's `meta.inferredFrom`.
- When the repo has Arazzo workflows, run `permdock arazzo check --doc <arazzo> --openapi <doc>`.
- When the app uses PermDock Cloud, add `permdock cloud push` to the deploy step after the deploy, with `PERMDOCK_CLOUD_URL` and `PERMDOCK_CLOUD_KEY` from CI secrets; pass `--manifest` with the `supabase inspect --out` file when the repo has one. A repo that builds from a Cloud project runs `permdock cloud pull --project <id>` with `PERMDOCK_CLOUD_TOKEN` before its checks instead. Locally, `permdock login` replaces both keys. The Cloud is optional and never on the decision path.
- `permdock skills install` copies these skills into the project's agent folders, writing a symlinked folder once through its target; `permdock skills install --check` in CI fails when the installed skills differ from the package version.
