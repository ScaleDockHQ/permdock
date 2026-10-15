---
"permdock": minor
---

Presets. `permdock/preset` resolves an archetype (`b2b`, `agent`, `marketplace`, `api`, `internal`, `consumer`) plus features, auth, backend, framework, agent runtimes, UI and Cloud services into a preset, encodes it as a versioned code (`p1…`) and generates the application's own files: `permissions.ts`, `policy.ts`, a `defineApp` in `permdock.ts`, framework and agent wiring, and `permdock.config.ts` for RLS. `permdock init --preset <code>` (or `--archetype`, `--framework`, `--feature`, `--agent`, `--ui`) writes them without overwriting existing files and prints the install and `shadcn` commands; `permdock preset decode|url <code>` reads a code.
