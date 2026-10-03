---
"permdock": minor
---

The test runners move into `permdock`: `@permdock/testing` is now the `permdock/testing` subpath, with `permdock/testing/saas` and `permdock/testing/saas/permissions`. Vitest is an optional peer, and no application entry imports the testing entries. Import from `permdock/testing` and drop the `@permdock/testing` dev dependency; `permdock` is the only package name.
