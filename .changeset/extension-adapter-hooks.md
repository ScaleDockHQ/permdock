---
"permdock": minor
---

HTTP adapters take `onDenied` to replace a refusal's Problem Details or `Response`, `context` to merge server-derived values into `subject.context`, and `wrap` with the new `wrapPermDock` helper; MCP and the AI SDK take the same `context` and `wrap`, and an `onDenied` that replaces the refusal text only. Behaviour changes: a `protect` loader that throws now answers `403` with reason `validation` instead of throwing, and Next.js `requireAccess` now runs the factory's `onDenied` unless the call passes its own.
