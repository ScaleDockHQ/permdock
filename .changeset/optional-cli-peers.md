---
"permdock": minor
---

BREAKING: `jiti` and `oxc-parser` are optional peers of `permdock` instead of dependencies. `permdock doctor`, `scan`, `collect` and `codemod` need `oxc-parser`, and a policy module Node cannot import natively needs `jiti`; a missing one fails with an install line. Run `pnpm add -D oxc-parser jiti` in a project that uses the CLI. The client store key is now `Symbol.for("permdock.store")`, and `permdock doctor` warns with PD092 when `pnpm-lock.yaml` resolves one `permdock` version with two peer sets.
