---
"permdock": minor
---

BREAKING: `subjectFromEve` from `permdock/eve` takes the principal from the turn's caller, `session.auth.current`, and falls back to `session.auth.initiator` only when the turn has none. `actorFromEve` always answers `{ id: "eve:app", kind: "eve" }`. A follow-up from another person in a shared session was decided with the initiator's grants before; it is now decided with the sender's ([#360](https://github.com/ScaleDockHQ/permdock/issues/360)).
