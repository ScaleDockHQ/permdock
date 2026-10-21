---
"permdock": minor
---

New `claim(path)` from `permdock` returns the condition ref `principal.claims.<path>` typed `SubjectRef`, so `where: { teamId: { in: claim("team_ids") } }` compiles under `noUncheckedIndexedAccess` and `noPropertyAccessFromIndexSignature`. `principal.claims` is now a declared ref field.
