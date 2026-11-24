---
"permdock": minor
---

`budgets` in `permdock.config.ts` sets byte budgets for the client bundle, the snapshot and the `memberships` claim; `permdock generate --check` exits 1 and doctor error `PD132` reports one the policy is over. `permdock bundle size` reports the bundle per role and shared part, the generated bundle module records its bytes and gzip bytes under the header, `PD112` probes with `omitStatic` when the `bundle` kind is generated and names `typeLevel`, `scopes` and `requires`, and doctor warning `PD133` reports `clientBundle(policy)` passed to a provider from a server module.
