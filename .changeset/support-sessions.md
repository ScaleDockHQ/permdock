---
"permdock": minor
---

Support sessions let a staff member view the app as one person: `permdock.decideSupportSession` requires a reason and, by default, an approval by someone else, and `signSupportSession` and `subjectFromSupportSession` from `permdock/server` carry the session with the staff member as a `support` actor. A support actor can never approve a request, and the tenant setting `supportSessions` only tightens.
