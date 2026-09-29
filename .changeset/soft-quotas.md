---
'permdock': minor
---

Soft and hard quotas. `limit` accepts `mode: 'hard' | 'soft'` (default `'hard'`, today's behaviour) and `alertAt`, a fraction of `count` in `(0, 1]`. A soft limit grants past its count with the obligation `{ kind: 'over-limit' }`; `alertAt` adds `{ kind: 'near-limit' }` once usage reaches it. A granted decision under a limit carries `quota: { remaining, resetsAt }` (`resetsAt` in Unix seconds), and `obligations` when one applies. An unreachable store still denies with `limit-unavailable` in soft mode. `describePolicy` matrix cells accept `obligations` (the expected kinds). New exported types: `GrantLimit`, `Quota`, `Obligation`.
