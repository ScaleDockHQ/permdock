---
'permdock': minor
'@permdock/testing': minor
---

UI adapters, from the real-life scenario suites:

- Client store: late refresh, verify and endpoint results are dropped after `replace`, `clear()` or a tenant change; endpoint answers are keyed by tenant and cleared on every new snapshot; `status()` is derived from the store's state instead of sticking at `pending` or `stale`; a status read never notifies subscribers synchronously; no endpoint request during a server render; `refresh({ tenant })` adds one `tenant` query parameter and commits the tenant only when the refresh succeeds; a signed refresh response and a signed `replace` go through `verifier`.
- React Native: a signed seed goes through `verifier`; the boot hydrate no longer overwrites async storage before it is read, and a late storage read never replaces a newer snapshot.
- `useApproval` (and the Vue, Svelte and Solid equivalents) polls `GET <approvals>/<token>` while subscribed and reports `pending`, `approved`, `rejected` or `expired`.
- Vue, Svelte and Solid accept a reactive or promise `snapshot`: a Vue ref or getter, a Svelte getter or readable store, a Solid accessor (including `createResource`). A promise keeps the store `pending` until it settles, for `<Suspense>`, `{#await}` and `createResource`.
- Svelte store factories recompute when a rune read in their `data`, `rows` or `options` getter changes. Vue and Solid `<Protected>` follow a changed `permission`; Solid `<Protected>` accepts JSX children.
- `permdock/svelte` publishes `Protected.svelte` as source under the `svelte` export condition, so SvelteKit server-renders it.
- WebMCP: re-registration reads the store's current instance; `inputSchema` uses Standard JSON Schema `jsonSchema.input({ target: 'draft-2020-12' })`; handlers receive `{ input, token }` (`WebMcpToolCall`); one abort listener on the parent signal.
- UI entries no longer pull the policy-definition chunk. `permdock/otel` (and every HTTP adapter through it) reads OpenTelemetry providers from the API's global registry, and `permdock/drizzle` loads `drizzle-orm` through a feature-detected `process.getBuiltinModule`, so neither entry imports `node:module`.
- `@permdock/testing` adds `testClientStore(name, createStore)`.
