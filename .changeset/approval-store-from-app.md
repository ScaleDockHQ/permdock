---
"permdock": minor
---

The approval store reaches an adapter only through the app or the adapter's own `store` option. Adapters no longer import a memory store for the `dev` profile, so every server, agent and UI adapter bundle is about 2.2 KB gzip smaller (`permdock/server` 41.7 KB to 39.5 KB, `permdock/ai-sdk` 38.6 KB to 36.4 KB, `permdock/next` 45.9 KB to 43.5 KB).

Under `profile: "dev"`, `defineApp` now fills in one memory `ApprovalStore` that every adapter of the app shares, instead of one store per adapter. A request opened through one adapter can be resolved and resumed through another. `prod` is unchanged.
