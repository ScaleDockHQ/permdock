---
"permdock": patch
---

`permdock rls verify` with the `guc` dialect now sets each fixture `claims` entry as `app.<name>`, as `withSubject` does, so a policy that reads a claim (`principal.claims.team_ids`) is checked against the database with that claim set.
