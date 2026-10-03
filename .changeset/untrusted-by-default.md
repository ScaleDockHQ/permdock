---
"permdock": minor
---

Decision data is untrusted unless the caller marks it. With `validate: 'boundary'`, `decide`, `can`, `filter`, `protect`, `conn.check` and the Nest guard validate a row against the resource schema unless the call passes `trusted: true`; pass it for rows your server loaded itself. The agent kernel labels tool data `boundary: 'tool-args'`. The AuthZEN handler forwards the loader's `trusted` flag and answers `decision: false` (`no-grant`, `detail: 'resource-unavailable'`) when the resource loader throws, instead of evaluating the request's `{ id }` stub.
