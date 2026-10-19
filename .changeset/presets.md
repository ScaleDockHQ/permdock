---
"permdock": minor
---

Presets. `permdock/preset` resolves an archetype (`b2b`, `agent`, `marketplace`, `api`, `internal`, `consumer`) plus features, auth, backend, framework, integrations and Cloud services into a preset, encodes it as a versioned code (`p1…`) and generates the application's own files: `permissions.ts`, `policy.ts`, a `defineApp` in `permdock.ts`, auth, backend, framework and agent wiring, and `permdock.config.ts`. `permdock init --preset <code>` (or `--archetype`, `--framework`, `--auth`, `--backend`, `--feature`, `--integration`, `--service`, the same ids /create offers) writes them without overwriting existing files and prints the install and `shadcn` commands; `permdock preset decode|url <code>` reads a code.
