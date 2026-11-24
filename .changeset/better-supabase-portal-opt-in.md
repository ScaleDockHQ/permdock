---
"permdock": minor
---

`authorizationProvider` fills `portalSubjects` only with `portalSubjects: true`: in 0.31.0 a contact's `<scope>.read` let them read every comment and internal note on their own record. `portalParties: false` leaves out `portalParties`.
