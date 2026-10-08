---
"permdock": minor
---

`permdock/nest` adds `PermDockModule.forRoot({ guard: 'global' })`, which registers `PermDockGuard` as `APP_GUARD`, and `decorateMethod(cls, key, ...decorators)` for code without decorator syntax. Gateway messages run the same OAuth scope check, loader, decision and approval resume as HTTP routes, and `PermDockExceptionFilter` handles `PermDockRevokedError`. `Protect(null)` in Nest, and `protect(null)` in `permdock/trpc` and `permdock/orpc`, need a principal and the declared OAuth scopes but no permission.

`permdock/express` answers a PermDock error from `permdock()`, `protect` or the decision endpoint with Problem Details instead of passing it to `next(err)`. `permdock()` in `permdock/orpc` reuses `context.permdock` only when it built that instance for the same tenant. `permdock/convex` takes `tenant` and `actor` options, and its `ConvexError` carries the marker Convex needs to send `data` to the client. `joseTokenVerifier` keys cached JWKS by `jwks_uri`, so keys from an old URI never answer after discovery moves it.
