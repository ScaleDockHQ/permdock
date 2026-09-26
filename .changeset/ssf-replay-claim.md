---
'permdock': minor
'@permdock/testing': minor
---

`permdock/ssf`: a `ReplayStore` may implement `claim(key, expiresAt?)` and `release(key)`, and `memoryReplayStore()` does, so two concurrent deliveries of one SET or `logout_token` dispatch once. Replay keys are namespaced by issuer, so receivers for two IdPs can share one store. A SET with several events records each event that succeeded, so a retry after a failed handler dispatches only the events that failed. Keys are no longer the bare `jti`: a persistent store upgraded in place may re-dispatch a SET delivered just before the upgrade once. `testReplayStore` covers the claim when a store implements it.
